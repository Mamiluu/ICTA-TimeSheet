const XLSX = require('xlsx');
const path = require('path');
const file = path.join('C:', 'Users', 'Asya Msanifu', 'Desktop', 'ICT Authority Workshop Talk.xlsx');
const wb = XLSX.readFile(file);
console.log('Sheets:', wb.SheetNames);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  console.log('--- Sheet:', name, 'rows:', rows.length);
  console.log(JSON.stringify(rows.slice(0, 6), null, 2));
}
