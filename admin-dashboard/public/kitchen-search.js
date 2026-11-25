const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function kitchenPhones(order) {
 return [...new Set([...(order.deliveryCoverage?.contactPhones || []), order.customerPhone].filter(p=>/^\+?\d[\d\s()-]{6,}$/.test(p || '')))];
}
export function kitchenName(order) {
 if (/\p{L}/u.test(order.deliveryCoverage?.recipientName || '')) return order.deliveryCoverage.recipientName;
 return /\p{L}/u.test(order.customer || '') ? order.customer : 'Nombre pendiente';
}
export function matchesKitchenOrder(order, query) {
 const q=normalize(query).trim(); if(!q)return true;
 const values=[kitchenName(order), order.customer, order.reference, String(order.number), ...kitchenPhones(order)];
 return values.some(v=>normalize(v).includes(q)) || (/^[+\d\s()-]+$/.test(q) && q.replace(/\D/g,'').length>2 && kitchenPhones(order).some(p=>p.replace(/\D/g,'').includes(q.replace(/\D/g,''))));
}

export function packingCustomerName(order) {
 const name=kitchenName(order);
 return name==='Nombre pendiente' ? order.reference||name : name;
}
export function packingBatchHeading(batch, orders) {
 if(!batch.headingBase)return batch.label;
 return batch.headingBase+' · '+orders.map(packingCustomerName).join(' → ');
}
