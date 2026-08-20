const XLSX = require('xlsx');
const path = require('path');
const file = path.join('C:', 'Users', 'Asya Msanifu', 'Desktop', 'ICT Authority Workshop Talk.xlsx');
const wb = XLSX.readFile(file, { cellDates: true });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
rows.sort((a, b) => {
  const ta = a['Timestamp'] instanceof Date ? a['Timestamp'].getTime() : 0;
  const tb = b['Timestamp'] instanceof Date ? b['Timestamp'].getTime() : 0;
  return ta - tb;
});
for (let i = 0; i < rows.length; i++) {
  const rowNum = i + 2;
  if (rowNum === 10 || rowNum === 60) {
    console.log('row', rowNum, JSON.stringify(rows[i]));
  }
}
