// Exact half-up rounding at the customer-charge boundary, including fractional grams.
// Intermediate recipe costs stay unrounded in the pricing engine.
function fraction(value) {
 if(!Number.isFinite(value)||value<0)throw new Error('Importe o cantidad inválidos.');
 const [mantissa,exponent='0']=String(value).toLowerCase().split('e');
 const [whole,decimal='']=mantissa.split('.');let n=BigInt(whole+decimal),d=10n**BigInt(decimal.length);
 const exp=Number(exponent);if(exp>=0)n*=10n**BigInt(exp);else d*=10n**BigInt(-exp);
 return [n,d];
}
export function chargeFor(price,quantity,base=1) {
 const [pn,pd]=fraction(price),[qn,qd]=fraction(quantity),[bn,bd]=fraction(base);
 if(bn===0n)throw new Error('La cantidad base debe ser positiva.');
 const n=pn*qn*bd,d=pd*qd*bn;
 const total=Number((2n*n+d)/(2n*d));
 if(!Number.isSafeInteger(total)||total>2000000000)throw new Error('El total supera el límite de COP permitido.');
 return total;
}
