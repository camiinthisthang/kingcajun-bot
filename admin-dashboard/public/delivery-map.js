import {deliveryInstructions,deliveryInstructionsHTML} from './delivery-instructions.js?v=request-filters-20261023';
import {savedDispatchLocation,pointMapsLink} from './location-utils.js?v=20261013-location-reminders';
import {displayAddress,deliveryDay,mapEligible,readyDelivery,geocodeQuery,acceptedCandidate} from './operations-view.js?v=20261013-location-reminders';
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dayLabel = o => new Intl.DateTimeFormat('es-CO',{weekday:'long',day:'numeric',month:'short',timeZone:'America/Bogota'}).format(new Date(o.starts_at));
const colors = ['#2468c9','#8852b4','#d47422','#287e65'];
export class DeliveryMap {
  constructor(onResolve) {this.onResolve=onResolve;this.cache = new Map();this.revision = 0;this.loaded = false;this.markers = new Map();}
  initialize() {
    if(this.map) return true;
    if(!window.L){document.querySelector('#map-status').textContent='No se pudo cargar el mapa. Actualiza la página; la lista sigue disponible.';return false;}
    this.map = L.map('delivery-map',{scrollWheelZoom:false}).setView([6.205,-75.575],12);
    this.layer = L.layerGroup().addTo(this.map);
    this.tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Powered by <a href="https://www.esri.com/">Esri</a>'}).addTo(this.map);
    this.tiles.on('tileerror',()=>{document.querySelector('#map-tile-warning').hidden=false;});
    this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    new ResizeObserver(()=>this.map.invalidateSize()).observe(document.querySelector('#delivery-map'));
    document.querySelector('#map-fit').addEventListener('click',()=>this.fit());
    document.querySelector('#map-locations').addEventListener('click',e=>{const locate=e.target.closest('[data-map-locate]');if(locate){this.onResolve(locate.dataset.mapLocate);return;}const button=e.target.closest('[data-map-order]');if(button){const marker=this.markers.get(button.dataset.mapOrder);if(marker){this.map.setView(marker.getLatLng(),16);marker.openPopup();}}});
    return true;
  }
  async lookup(query, signal) {
    const key=JSON.stringify(query);
    if(this.cache.has(key))return this.cache.get(key);
    const url = new URL('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates');
    url.search = new URLSearchParams({f:'json',address:query.street,city:query.city,region:'Antioquia',sourceCountry:'COL',outSR:'4326',outFields:'Addr_type,City,Match_addr',forStorage:'false',maxLocations:'3'});
    const response = await fetch(url,{signal,credentials:'omit',referrerPolicy:'no-referrer'});
    if(!response.ok) throw new Error('lookup');
    const result=await response.json();if(result.error)throw new Error('lookup');
    const candidate=acceptedCandidate(result.candidates||[],query);
    this.cache.set(key,candidate); // Memory only: discarded on refresh, never saved to a database/storage.
    return candidate;
  }
  async render(orders) {
    this.orders=orders;
    const rev=++this.revision;this.abort?.abort();this.abort=new AbortController();
    if(!this.initialize())return;
    const eligible=orders.filter(mapEligible);
    const days=[...new Set(orders.map(deliveryDay))].sort();
    this.layer.clearLayers();this.markers.clear();this.points=[];
    document.querySelector('#map-legend').innerHTML=days.map((d,i)=>`<span><i style="background:${colors[i%colors.length]}"></i>${esc(dayLabel(orders.find(o=>deliveryDay(o)===d)))}</span>`).join('')+'<span class="map-key">Pin claro: pendiente de confirmar</span>';
    document.querySelector('#map-locations').innerHTML='';
    document.querySelector('#map-status').textContent=eligible.length?'Ubicando direcciones…':'No hay domicilios activos con estos filtros.';
    let found=0,missing=0,failed=0,verified=0;
    const results=[];
    for(const [index,order] of eligible.entries()) {
      if(rev!==this.revision)return;
      const saved=savedDispatchLocation(order);
      let candidate=saved?{address:saved.label||'Punto revisado por el equipo',verified:true,location:{x:saved.lng,y:saved.lat}}:null,error=false;
      const query=geocodeQuery(order);
      if(query&&!candidate)try{candidate=await this.lookup(query,AbortSignal.any([this.abort.signal,AbortSignal.timeout(9000)]));}catch{if(rev!==this.revision)return;error=true;}
      if(rev!==this.revision)return;
      const color=colors[days.indexOf(deliveryDay(order))%colors.length];
      if(candidate){
        found++;if(candidate.verified)verified++;
        const marker=L.marker([candidate.location.y,candidate.location.x],{icon:L.divIcon({className:'delivery-pin',html:`<span style="--pin-color:${color}" class="${readyDelivery(order)?'':'pending'}">${index+1}</span>`,iconSize:[30,34],iconAnchor:[15,34]}),title:`${order.public_id} · ${displayAddress(order)}`}).addTo(this.layer);
        marker.bindPopup(`<div class="delivery-popup"><strong>${esc(order.display_name||'Cliente')} · ${esc(order.public_id)}</strong><p>${esc(displayAddress(order))}</p><small>${esc(dayLabel(order))} · ${readyDelivery(order)?'Confirmado':'Sin confirmar'}</small>${deliveryInstructionsHTML(deliveryInstructions(order))}<p class="matched-address">${candidate.verified?'Ubicación verificada':'Ubicación estimada'}: ${esc(candidate.address)}</p><a target="_blank" rel="noopener noreferrer" href="${saved?pointMapsLink(saved):'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query?query.street+', '+query.city+', Colombia':displayAddress(order)+', Colombia')}">Abrir dirección ↗</a></div>`);
        this.markers.set(order.public_id,marker);this.points.push(marker.getLatLng());
      }else{missing++;if(error)failed++;}
      results.push({order,index,candidate,error});
      document.querySelector('#map-status').textContent=`${found} de ${eligible.length} domicilios ubicados · ${verified} guardados y ${found-verified} estimados${index+1<eligible.length?' · ubicando…':missing?' · '+missing+' por ubicar':''}`;
      document.querySelector('#map-locations').innerHTML=results.map(({order:o,index:i,candidate:c,error:e})=>`<li class="${c?'':'unlocated'}"><button type="button" data-map-order="${esc(o.public_id)}" ${c?'':'disabled'}><span class="location-number">${i+1}</span><span><strong>${esc(o.display_name||o.public_id)}</strong><small>${esc(displayAddress(o))}</small><small>${esc(o.public_id)} · ${readyDelivery(o)?'Confirmado':'Sin confirmar'}${c?(c.verified?' · ubicación verificada':' · ubicación estimada'):e?' · mapa no disponible':' · falta ubicación precisa'}</small></span></button>${deliveryInstructionsHTML(deliveryInstructions(o))}<button class="map-locate-button" type="button" data-map-locate="${esc(o.public_id)}">${c?.verified?'Editar ubicación':'Resolver ubicación'}</button></li>`).join('');
    }
    if(rev!==this.revision)return;
    document.querySelector('#map-retry').hidden=failed===0;
    this.fit();
  }
  fit(){if(this.points?.length)this.map.fitBounds(L.latLngBounds(this.points),{padding:[40,40],maxZoom:15});else this.map?.setView([6.205,-75.575],12);}
}
