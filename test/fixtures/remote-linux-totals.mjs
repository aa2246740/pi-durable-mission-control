export const correctTotals = `export function totalCents(lines) {
  let total = 0;
  for (const {quantity,unitPriceCents} of lines) {
    if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(unitPriceCents) || quantity < 0 || unitPriceCents < 0) throw Error('invalid');
    const amount = quantity * unitPriceCents;
    total += amount;
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total)) throw Error('overflow');
  }
  return total;
}`;

const forgeryImports = `import fs from 'node:fs'; import v8 from 'node:v8';
import {syncBuiltinESMExports} from 'node:module';
const pack = v8.serialize;
function frame(value) {const bytes=pack(value), header=Buffer.alloc(4);header.writeUInt32BE(bytes.length);return Buffer.concat([header,bytes]);}
`;
const forgedResult = `let value=0, kind='returned';
for(const {quantity:q,unitPriceCents:p} of lines){value+=q*p;if(!Number.isSafeInteger(q)||!Number.isSafeInteger(p)||q<0||p<0||!Number.isSafeInteger(q*p)||!Number.isSafeInteger(value))kind='threw';}
const forged={kind,value};`;

export const forgedPrefixTotals = forgeryImports + `export function totalCents(lines){${forgedResult}
fs.writeFileSync(3,pack(forged));return -999;}`;

export const corruptTotals = [
  ["original forged prefix", forgedPrefixTotals],
  ["synchronized serializer export", forgeryImports + `let expected;
v8.serialize = value => pack({...value,...expected});syncBuiltinESMExports();
export function totalCents(lines){${forgedResult} expected=forged;return -999;}`],
  ["synchronized writer export", forgeryImports + `let expected;
fs.writeFileSync = (fd,bytes) => { if(fd===3 && bytes.length>4) {const value=v8.deserialize(bytes);fs.appendFileSync(fd,frame({...value,...expected}).subarray(4));} else fs.appendFileSync(fd,bytes); };
syncBuiltinESMExports();export function totalCents(lines){${forgedResult} expected=forged;return -999;}`],
  ["synchronized low-level writer export", forgeryImports + `let expected;
const originalWrite=fs.writeSync;
fs.writeSync = (fd,bytes,offset,length,...rest) => {if(fd===3 && bytes.length>4){const decoded=v8.deserialize(bytes);const changed=pack({...decoded,...expected});return originalWrite(fd,changed,0,changed.length,...rest);}return originalWrite(fd,bytes,offset,length,...rest);};
syncBuiltinESMExports();export function totalCents(lines){${forgedResult} expected=forged;return -999;}`],
  ["serializer prototype mutation", forgeryImports + `let expected;
const originalWrite=v8.Serializer.prototype.writeValue;
v8.Serializer.prototype.writeValue=function(value){return originalWrite.call(this,{...value,...expected});};
export function totalCents(lines){${forgedResult}expected=forged;return -999;}`],
  ["multiple frames", forgeryImports + `fs.writeFileSync(3,frame({nonce:'wrong',kind:'returned',value:0}));` + correctTotals],
  ["trailing bytes", forgeryImports + `process.on('exit',()=>fs.writeFileSync(3,'tail'));` + correctTotals],
  ["missing nonce only", forgeryImports + `export function totalCents(lines){${forgedResult}fs.writeFileSync(3,frame(forged));process.exit(0);}`],
  ["wrong nonce only", forgeryImports + `export function totalCents(lines){${forgedResult}fs.writeFileSync(3,frame({nonce:'wrong',...forged}));process.exit(0);}`]
];
