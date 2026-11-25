(() => {
const load=src=>new Promise((resolve,reject)=>{const i=new Image();i.onload=()=>resolve(i);i.onerror=()=>reject(new Error('No se pudo cargar la ilustración.'));i.src=src;});
let assets;
window.makeKingCajunInvite=async function({kind='vik',name=''}){
  if(!assets)assets=Promise.all([load('/vik-assets/assets/supper-engraving.png'),load('/vik-assets/assets/logo-cream.svg')]);
  const [art,logo]=await assets;await document.fonts.ready;const family=kind==='family';
  const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1620;const c=canvas.getContext('2d');
  c.fillStyle='#B5231C';c.fillRect(0,0,1080,1620);
  c.drawImage(art,0,0,1080,1620);
  c.strokeStyle='rgba(244,235,217,.55)';c.lineWidth=1.5;c.strokeRect(24,24,1032,1572);
  // Use the complete supplied logo, with no circle, mask, or crop.
  c.save();c.filter='blur(14px)';c.fillStyle='#B5231C';c.fillRect(421,62,238,265);c.restore();
  c.drawImage(logo,440,90,200,200*logo.naturalHeight/logo.naturalWidth);
  c.fillStyle='#F4EBD9';c.textAlign='center';c.textBaseline='alphabetic';
  const text=(value,y,size=25,familyName='Archivo',spacing=0)=>{c.font='500 '+size+'px '+familyName;c.letterSpacing=spacing+'px';c.fillText(value,540,y);c.letterSpacing='0px';};
  text(family?'INVITACIÓN · AMIGOS Y FAMILIA':'INVITACIÓN PRIVADA',380,19,'Archivo',2);
  const recipient=name.trim()||'Tu nombre';let size=88;
  while(size>28){c.font='500 '+size+'px Georgia';if(c.measureText(recipient+',').width<760)break;size--;}
  text(recipient+',',505,size,'Georgia');
  if(family){text('Te invitamos a nuestra',589,53,'Georgia');text('primera noche.',652,53,'Georgia');}
  else text('Estás en la lista.',610,64,'Georgia');
  text(family?'Queremos celebrar este paso con':'Gracias por estar desde el comienzo.',family?728:690,27);
  text(family?'nuestros amigos y nuestra familia.':'Una apertura en secreto.',family?769:738,27);
  text(family?'Nos encantaría compartirlo contigo.':'Solo para quienes recibieron esta invitación',family?810:780,family?27:25);
  if(!family)text('y hasta 3 acompañantes.',818,27);
  c.strokeStyle='rgba(244,235,217,.6)';c.beginPath();c.moveTo(355,854);c.lineTo(725,854);c.stroke();
  text(family?'JUEVES 19 DE NOVIEMBRE':'DOMINGO 22 DE NOVIEMBRE',family?904:884,22,'Archivo',1);
  if(family)text('7 p. m.',958,39,'Georgia');
  else{c.fillStyle='#F4EBD9';c.fillRect(300,906,480,103);c.fillStyle='#2340D3';text('ELIGE TU HORA',935,16,'Archivo',2);c.fillStyle='#12100F';text('2pm // 6pm',984,44,'Georgia');c.fillStyle='#F4EBD9';}
  text('El Poblado · Medellín',family?1004:1042,21);
  c.fillStyle='#B5231C';c.fillRect(145,1508,790,65);c.fillStyle='#F4EBD9';text(family?'CONFIRMA TU ASISTENCIA Y RESERVA EN EL ENLACE.':'RESERVA EN TU ENLACE PERSONAL. NO LO COMPARTAS.',1547,17,'Archivo',1);
  return canvas;
};
})();
