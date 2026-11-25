// Present the saved order recipe, never today's editable menu.
const number = n => new Intl.NumberFormat('es-CO', { maximumFractionDigits: 3 }).format(n);
export function preparationQuantity(i) {
  if (i.pieces?.length) {
    const pieces = i.pieces.map(p => `${number(p.count)} ${p.setting === 'snow_cluster_g' ? 'racimos enteros' : p.setting === 'snow_leg_g' ? 'patas sueltas' : p.label}`).join(' + ');
    return { name: i.name, amount: pieces + (i.weightOnlyQuantity ? ` + ${number(i.weightOnlyQuantity)} ${i.unit}` : ''),
      detail: `${number(i.quantity)} ${i.unit} en total · antes de cocinar${i.weightOnlyQuantity ? ' · cantidad adicional sin conteo en la receta' : ''}` };
  }
  const result = recipeQuantity(i);
  if (i.unit === 'g') return { ...result, amount: `${number(i.quantity)} g`, detail: 'Antes de cocinar · receta definida por peso' };
  return result;
}
export function recipeQuantity(i) {
  if(i.pieces?.length)return {name:i.name,amount:i.pieces.map(p=>`${new Intl.NumberFormat('es-CO',{maximumFractionDigits:3}).format(p.count)} ${p.label}`).join(' + '),detail:`${i.quantity} ${i.unit} antes de cocinar`};
  if (i.unit === 'ml') return {name:i.name,amount:`${i.quantity} ml`,detail:'Cantidad de receta'};
  if (i.unit === 'g') return { name: i.name, amount: `${i.quantity} g`, detail: 'Antes de cocinar' };
  if (i.id === 'test-half-corn') return { name: 'Mazorca', amount: `${number(i.quantity * 2)} pedazos`, detail: '2 pedazos por media mazorca.' };
  if ((i.id?.startsWith('ingredient_9_') || i.name === 'Mazorca') && (i.packFactor || 1) === 1) {
    return { name: i.name, amount: `${number(i.quantity * 4)} pedazos`, detail: '4 pedazos por mazorca entera · 2 por media mazorca.' };
  }
  const plural = i.packLabel || 'piezas';
  const singular = {piezas:'pieza',salchichas:'salchicha','patas enteras':'pata entera','patas sueltas':'pata suelta','racimos enteros':'racimo entero','huevos cocidos':'huevo cocido','pedazos de pan de maiz':'pedazo de pan de maiz'};
  const label = i.quantity === 1 && (i.packFactor || 1) === 1 ? (singular[plural] || plural) : plural;
  if ((i.packFactor || 1) > 1) return { name: i.name, amount: `${i.quantity} ${i.quantity === 1 ? 'unidad' : 'unidades'}`, detail: `${i.quantity * i.packFactor} ${label}` };
  return { name: i.name, amount: `${i.quantity} ${label}`, detail: '' };
}
