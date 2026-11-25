import {savedDispatchLocation,validDispatchPoint,pointMapsLink,coordinatePair,googleMapsUrl} from './location-utils.js?v=20261013-location-reminders';
import {geocodeQuery} from './operations-view.js?v=20261013-location-reminders';
const $ = selector => document.querySelector(selector);

export class LocationEditor {
  constructor({api,onSaved,onRefresh}) {
    this.api=api;this.onSaved=onSaved;this.onRefresh=onRefresh;this.drafts=new Map();
    this.dialog=$('#location-dialog');
    $('#location-close').onclick=()=>this.close();
    $('#location-done').onclick=()=>this.close();
    this.dialog.addEventListener('cancel',e=>{e.preventDefault();this.close();});
    $('#location-form').addEventListener('submit',e=>{e.preventDefault();this.save();});
    $('#location-import').onclick=()=>this.importPoint();
    $('#location-label').addEventListener('input',()=>this.changed());
    $('#location-link').addEventListener('input',()=>{
      this.inputRevision++;clearTimeout(this.importTimer);this.linkPending=Boolean($('#location-link').value.trim());
      $('#location-verified').checked=false;$('#location-error').textContent='';
      $('#location-import-status').textContent=this.linkPending?'El enlace aún no se ha aplicado al mapa.':'';
      const value=$('#location-link').value.trim();
      if(googleMapsUrl(value)||validDispatchPoint(coordinatePair(value))){
        $('#location-import-status').textContent='Cargando el punto del enlace…';
        this.importTimer=setTimeout(()=>this.importPoint(),600);
      }
      this.updateSave();
    });
    $('#location-verified').addEventListener('change',()=>this.updateSave());
    $('#location-search').addEventListener('input',()=>this.searchLink());
    $('#location-reset').onclick=async()=>{
      if(this.busy)return;
      $('#location-reset').disabled=true;
      try {const order=await this.onRefresh(this.order.public_id);if(!order)throw new Error('Este pedido ya no aparece con los filtros actuales.');this.drafts.delete(order.public_id);this.dialog.close();this.open(order);}
      catch(error){$('#location-error').textContent=error.message;}
      finally{$('#location-reset').disabled=false;}
    };
  }
  open(order) {
    if(this.busy)return;
    this.order=order;this.inputRevision=(this.inputRevision||0)+1;this.requestRevision=(this.requestRevision||0)+1;
    const stored=savedDispatchLocation(order), draft=this.drafts.get(order.public_id);
    this.expectedAddress=draft?.expectedAddress ?? (order.delivery_address||'');
    this.expectedRevision=draft ? draft.expectedRevision : (order.delivery_coverage?.dispatchLocation?.revision||null);
    this.point=draft?.point || stored || null;this.dirty=draft?.dirty||false;this.mutationId=draft?.mutationId||crypto.randomUUID();this.importing=false;this.linkPending=draft?.linkPending||false;
    $('#location-title').textContent=order.display_name || 'Ubicación de entrega';
    $('#location-order').textContent=order.public_id;
    $('#location-original').textContent=order.delivery_address || 'Sin dirección escrita';
    $('#location-label').value=draft?.label ?? stored?.label ?? '';
    const query=geocodeQuery(order);
    $('#location-search').value=draft?.search ?? (query?query.street+', '+query.city+', Colombia':'');
    $('#location-link').value=draft?.link || '';
    $('#location-verified').checked=false;
    $('#location-error').textContent='';
    $('#location-import-status').textContent=this.linkPending?'Pulsa Cargar punto para aplicar el enlace.':'';
    $('#location-reset').hidden=true;
    this.setState(draft?'Borrador sin guardar':stored?'Ubicación guardada':'Por ubicar');
    this.searchLink();this.dialog.showModal();
    if(!this.map && window.L) {
      this.map=L.map('location-preview',{scrollWheelZoom:false});
      const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(this.map);
      tiles.on('tileerror',()=>{$('#location-tile-warning').hidden=false;});
      this.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
      this.map.on('click',e=>{if(!this.busy)this.choose({lat:e.latlng.lat,lng:e.latlng.lng});});
      new ResizeObserver(()=>this.map.invalidateSize()).observe($('#location-preview'));
    }
    this.paintPoint(true);this.updateSave();
    $('#location-import').disabled=false;
    requestAnimationFrame(()=>this.map?.invalidateSize());
  }
  searchLink() {
    const query=$('#location-search').value.trim();
    const link=$('#location-google');link.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(query||'Medellín, Colombia');
  }
  setState(text){$('#location-state').textContent=text;}
  updateSave(){
    const ready=validDispatchPoint(this.point)&&!this.linkPending&&!this.importing;
    $('#location-save').disabled=this.busy||!this.dirty||!ready||!$('#location-verified').checked;
    $('#location-verified').disabled=this.busy||!ready;
    $('#location-next-step').textContent=this.busy?'Guardando ubicación…':this.importing?'Espera a que aparezca el pin.':this.linkPending?'Carga el enlace para ver el nuevo pin antes de guardar.':!ready?'Primero carga un enlace o toca el mapa para colocar el pin.':!this.dirty?'Ubicación guardada. Puedes cerrar esta ventana.':!$('#location-verified').checked?'Revisa el pin y marca la casilla de arriba para habilitar Guardar ubicación.':'Listo para guardar: pulsa Guardar ubicación.';
  }
  changed(){this.dirty=true;this.mutationId=crypto.randomUUID();$('#location-verified').checked=false;this.setState('Cambios sin guardar');this.updateSave();}
  choose(point) {
    if(!validDispatchPoint(point)){$('#location-error').textContent='Marca un punto en Medellín o sus alrededores.';$('#location-verified').checked=false;this.paintPoint();this.updateSave();return;}
    clearTimeout(this.importTimer);this.linkPending=false;this.pointRevision=(this.pointRevision||0)+1;this.point={lat:Number(point.lat.toFixed(7)),lng:Number(point.lng.toFixed(7))};
    $('#location-import-status').textContent='Punto cargado. Revisa la ubicación en el mapa.';
    $('#location-error').textContent='';this.changed();this.paintPoint();
  }
  paintPoint(center=false) {
    this.marker?.remove();this.marker=null;
    if(this.point && this.map) {
      this.marker=L.marker([this.point.lat,this.point.lng],{draggable:true}).addTo(this.map);
      this.marker.on('dragend',()=>{const p=this.marker.getLatLng();this.choose({lat:p.lat,lng:p.lng});});
    }
    if(center)this.map?.setView(this.point?[this.point.lat,this.point.lng]:[6.205,-75.575],this.point?17:12);
    $('#location-coordinates').textContent=this.point?this.point.lat.toFixed(6)+', '+this.point.lng.toFixed(6):'Toca el mapa para colocar un pin.';
    const link=$('#location-point-link');link.hidden=!this.point;if(this.point)link.href=pointMapsLink(this.point);
  }
  async importPoint() {
    clearTimeout(this.importTimer);
    const revision=++this.requestRevision, inputRevision=this.inputRevision, pointRevision=this.pointRevision;
    this.importing=true;this.updateSave();
    $('#location-import').disabled=true;$('#location-import').textContent='Cargando…';$('#location-error').textContent='';
    $('#location-import-status').textContent='Buscando el punto exacto del enlace…';
    try {
      const point=await this.api('/api/admin/dispatch-location/resolve',{method:'POST',body:JSON.stringify({value:$('#location-link').value})});
      if(revision!==this.requestRevision||inputRevision!==this.inputRevision||pointRevision!==this.pointRevision||!this.dialog.open)return;
      this.choose(point);this.paintPoint(true);
    } catch(error){if(revision===this.requestRevision && inputRevision===this.inputRevision && this.dialog.open){$('#location-error').textContent=error.message;$('#location-import-status').textContent=error.message;}}
    finally{if(revision===this.requestRevision){$('#location-import').disabled=false;$('#location-import').textContent='Cargar punto';this.importing=false;this.updateSave();}}
  }
  async save() {
    if(this.busy||this.importing||this.linkPending||!this.dirty||!validDispatchPoint(this.point)||!$('#location-verified').checked)return;
    this.busy=true;this.setState('Guardando…');$('#location-error').textContent='';
    $('#location-fields').disabled=true;this.marker?.dragging.disable();this.updateSave();
    try {
      const result=await this.api('/api/admin/orders/'+encodeURIComponent(this.order.public_id)+'/dispatch-location',{method:'PUT',body:JSON.stringify({...this.point,label:$('#location-label').value,verified:true,expectedAddress:this.expectedAddress,expectedRevision:this.expectedRevision,mutationId:this.mutationId})});
      this.expectedRevision=result.location.revision;this.dirty=false;this.drafts.delete(this.order.public_id);
      $('#location-link').value='';
      this.setState('Guardado · disponible en todos tus dispositivos');
      this.onSaved(result);
    } catch(error){this.setState('Guardado no confirmado · tus cambios siguen aquí');$('#location-error').textContent=error.message;$('#location-reset').hidden=false;}
    finally{this.busy=false;$('#location-fields').disabled=false;this.marker?.dragging.enable();this.updateSave();}
  }
  close() {
    if(this.busy)return;
    if(this.dirty || $('#location-link').value) this.drafts.set(this.order.public_id,{dirty:this.dirty,point:this.point,linkPending:this.linkPending,label:$('#location-label').value,search:$('#location-search').value,link:$('#location-link').value,expectedAddress:this.expectedAddress,expectedRevision:this.expectedRevision,mutationId:this.mutationId});
    clearTimeout(this.importTimer);this.requestRevision++;$('#location-import').disabled=false;$('#location-import').textContent='Cargar punto';this.dialog.close();
  }
}
