// Works with frozen sale customizations, including existing manually recovered orders.
export function saleLineLabel(name,quantity,customization={}) {
 if(!customization?.wholePiece)return `${quantity}× ${name}`;
 return `${customization.wholePieceCount} ${customization.wholePiece==='racimo_entero'?'racimo(s) entero(s) de cangrejo de nieve':'pata(s) entera(s) de cangrejo rey'} · aprox. ${customization.estimatedWeightGrams} g`;
}
export function wholePieceNote(customization) {
 if(customization?.wholePiece&&customization.finalWeightPending===false)return `${saleLineLabel('',0,customization)}. Preparar la pieza ENTERA, sin recortar. Precio fijo por pieza; el peso es orientativo para preparación.`;
 return `${saleLineLabel('',0,customization)}. Preparar la pieza ENTERA; el peso es estimado, no recortar para ajustarlo. Pesar antes de empacar y revisar el total y saldo con el cliente según la tarifa por peso de su pedido antes de cobrar.`;
}
export function variableWeightNotice(customizations) {
 return customizations.some(c=>c?.finalWeightPending)?'\n\n⚖️ Total y saldo estimados: las piezas enteras de cangrejo se cobran según el peso real. El equipo te confirma el valor final antes del cobro.':'';
}
