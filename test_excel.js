const fs = require('fs');
const XLSX = require('./xlsx.js');

try {
  const fileBuffer = fs.readFileSync('C:\\Users\\parth\\Downloads\\0. Chair Data- WS4 2026 - Parth.xlsx');
  const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 'A', raw: false, defval: '' });
  
  console.log('Total rows parsed:', rows.length);
  if (rows.length === 0) {
    console.log('No rows!');
    process.exit(0);
  }
  
  // Print first row
  console.log('Row 0:', rows[0]);
  console.log('Row 1:', rows[1]);
  
  // Find header row index
  let headerRowIndex = 0;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const values = Object.values(rows[i]).map(v => String(v).toLowerCase());
    if (values.some(v => v.includes("email") || v.includes("mail"))) {
      headerRowIndex = i;
      break;
    }
  }
  console.log('Detected headerRowIndex:', headerRowIndex);
  
  const headerRow = rows[headerRowIndex];
  const colLetters = Object.keys(headerRow).filter(k => /^[A-Z]+$/i.test(k));
  console.log('Col letters:', colLetters);
  
  const getColumnLetter = (headerRow, alternatives) => {
    for (const alt of alternatives) {
      const match = Object.keys(headerRow).find(key => {
        const val = String(headerRow[key]).trim().toLowerCase();
        return val === alt.toLowerCase();
      });
      if (match) return match;
    }
    for (const alt of alternatives) {
      const match = Object.keys(headerRow).find(key => {
        const val = String(headerRow[key]).trim().toLowerCase();
        return val.includes(alt.toLowerCase());
      });
      if (match) return match;
    }
    return null;
  };
  
  const nameCol = getColumnLetter(headerRow, ["Name", "First Name", "Recipient Name", "Full Name", "Contact Name"]);
  const emailCol = getColumnLetter(headerRow, ["Email", "Email Address", "Mail", "EmailID"]);
  
  console.log('Mapped nameCol:', nameCol);
  console.log('Mapped emailCol:', emailCol);
  
} catch (e) {
  console.error('Error:', e);
}
