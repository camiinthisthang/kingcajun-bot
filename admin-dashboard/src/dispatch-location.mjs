import {requireValue,KitchenError} from './kitchen-domain.mjs';
import {coordinatePair,googleMapsUrl,isShortGoogleUrl,pointFromGoogleUrl,validDispatchPoint} from '../public/location-utils.js';
import {mapEligible} from '../public/operations-view.js';

const hint = 'El enlace no contiene un punto exacto. En Google Maps selecciona el lugar y copia sus coordenadas (latitud, longitud), o marca el punto en el mapa.';
export async function resolveLocationInput(input, fetcher = fetch) {
  const value = typeof input?.value === 'string' ? input.value.trim() : '';
  requireValue(value.length > 0 && value.length <= 4096,'Pega un enlace de Google Maps o las coordenadas.');
  let point = coordinatePair(value);
  if (!point) {
    let url = googleMapsUrl(value);
    requireValue(url,'Usa un enlace HTTPS de Google Maps o coordenadas como 6.20, -75.57.');
    if (isShortGoogleUrl(url)) {
      const signal = AbortSignal.timeout(8000);
      try {
        for (let hop = 0; hop < 5; hop++) {
          // Never forward credentials; every redirect is checked before a request.
          const response = await fetcher(url.href,{redirect:'manual',signal,headers:{accept:'text/html'}});
          await response.body?.cancel();
          requireValue([301,302,303,307,308].includes(response.status),hint);
          const next = new URL(response.headers.get('location') || '',url);
          url = googleMapsUrl(next.href);
          requireValue(url,'El enlace redirige fuera de Google Maps. Copia las coordenadas del lugar.');
          point = pointFromGoogleUrl(url);
          if (point) break;
          if (!isShortGoogleUrl(url)) break;
        }
      } catch (error) {
        if (error instanceof KitchenError) throw error;
        throw new KitchenError('No se pudo abrir el enlace. Intenta de nuevo o pega las coordenadas del lugar.');
      }
    } else point = pointFromGoogleUrl(url);
    requireValue(point,hint);
  }
  requireValue(validDispatchPoint(point),'El punto debe estar en Medellín o sus alrededores. Revisa el orden: latitud, longitud.');
  return point;
}

export async function saveDispatchLocation(db,publicId,input,actor) {
  requireValue(input?.verified === true,'Revisa el pin y confirma que corresponde al lugar.');
  requireValue(validDispatchPoint(input),'El punto debe estar en Medellín o sus alrededores.');
  requireValue(typeof input.expectedAddress === 'string','Actualiza el pedido antes de guardar.',409);
  requireValue(input.expectedRevision === null || typeof input.expectedRevision === 'string','Actualiza la ubicación antes de guardar.',409);
  requireValue(typeof input.mutationId === 'string' && /^[a-zA-Z0-9-]{16,64}$/.test(input.mutationId),'Identificador de guardado inválido.');
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  requireValue(label.length <= 160,'El nombre del edificio o lugar puede tener hasta 160 caracteres.');
  return db.transaction(async tx => {
    const order = (await tx.query('SELECT * FROM orders WHERE public_id=$1 FOR UPDATE',[publicId])).rows[0];
    requireValue(order,'Pedido no encontrado.',404);
    requireValue(mapEligible(order),'Este pedido ya no es un domicilio activo. Actualiza la lista.',409);
    requireValue((order.delivery_address || '') === input.expectedAddress,'La dirección cambió. Actualiza el pedido y revisa el punto antes de guardar.',409);
    const coverage = order.delivery_coverage || {};
    const previous = coverage.dispatchLocation;
    if (previous?.revision === input.mutationId) {
      requireValue(previous.lat === input.lat && previous.lng === input.lng && previous.label === label,'Este guardado ya contiene otro punto. Actualiza el pedido.',409);
      return {publicId,location:previous};
    }
    requireValue((previous?.revision || null) === input.expectedRevision,'Otra persona cambió la ubicación. Actualiza el pedido para revisar el punto guardado.',409);
    const location = {lat:input.lat,lng:input.lng,label,source:'staff_verified',sourceAddress:order.delivery_address || '',revision:input.mutationId,updatedAt:new Date().toISOString(),updatedBy:actor};
    if(coverage.locationConfirmation?.status==='needs_correction')await tx.query("UPDATE orders SET delivery_coverage=jsonb_set(delivery_coverage,'{locationConfirmation}',$2::jsonb) WHERE id=$1",[order.id,JSON.stringify({status:'awaiting_customer',at:new Date().toISOString(),pointRevision:location.revision})]);
    await tx.query("UPDATE orders SET delivery_coverage=jsonb_set(COALESCE(delivery_coverage,'{}'::jsonb),'{dispatchLocation}',$2::jsonb) WHERE id=$1",[order.id,JSON.stringify(location)]);
    return {publicId,location};
  });
}
