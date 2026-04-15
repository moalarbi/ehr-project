/**
 * EHTIMAM - Daily Revenue Recording System
 * Google Apps Script backend for GitHub Pages frontend.
 * Backward-compatible update for Wallet + TipAmount + employee monthly revenue.
 */

const SHEETS = {
  USERS: 'Users',
  EMPLOYEES: 'Employees',
  ENTRIES: 'Entries'
};

const ENTRY_HEADERS = ['Date', 'Driver', 'Employee', 'PaymentMethod', 'Amount', 'TipAmount', 'Timestamp'];

function doGet(e) {
  try {
    const action = String((e.parameter && e.parameter.action) || '').trim();
    let result;

    switch (action) {
      case 'login':
        result = login_(e.parameter.password || '');
        break;
      case 'getEmployees':
        result = { success: true, items: getEmployees_() };
        break;
      case 'getDashboard':
        result = { success: true, ...getDashboard_(e.parameter || {}) };
        break;
      case 'getEmployeeMonthlyRevenue':
        result = { success: true, items: getEmployeeMonthlyRevenue_(e.parameter || {}) };
        break;
      default:
        result = { success: false, message: 'Invalid GET action' };
    }

    return jsonResponse_(result);
  } catch (error) {
    return jsonResponse_({ success: false, message: error.message });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse((e.postData && e.postData.contents) || '{}');
    const action = String(body.action || '').trim();
    const payload = body.payload || {};
    let result;

    switch (action) {
      case 'submitEntries':
        result = submitEntries_(payload);
        break;
      case 'addDriver':
        result = addDriver_(payload);
        break;
      case 'updateDriver':
        result = updateDriver_(payload);
        break;
      case 'toggleDriverStatus':
        result = toggleDriverStatus_(payload);
        break;
      case 'addEmployee':
        result = addEmployee_(payload);
        break;
      case 'updateEmployee':
        result = updateEmployee_(payload);
        break;
      case 'toggleEmployeeStatus':
        result = toggleEmployeeStatus_(payload);
        break;
      default:
        result = { success: false, message: 'Invalid POST action' };
    }

    return jsonResponse_(result);
  } catch (error) {
    return jsonResponse_({ success: false, message: error.message });
  }
}

function login_(password) {
  if (!password) return { success: false, message: 'Password required' };

  const rows = getObjects_(getSheet_(SHEETS.USERS));
  const user = rows.find(function(row) {
    return String(row.Password || '').trim() === String(password).trim() &&
      normalizeStatus_(row.Status) === 'active';
  });

  if (!user) return { success: false, message: 'Invalid password' };

  return {
    success: true,
    user: {
      role: String(user.Role || '').trim().toLowerCase(),
      driverName: String(user.DriverName || '').trim()
    }
  };
}

function getEmployees_() {
  return getObjects_(getSheet_(SHEETS.EMPLOYEES)).map(function(row) {
    return {
      name: String(row.Name || '').trim(),
      status: normalizeStatus_(row.Status)
    };
  }).filter(function(item) {
    return item.name;
  });
}

function submitEntries_(payload) {
  const date = String(payload.date || '').trim();
  const driver = String(payload.driver || '').trim();
  const entries = Array.isArray(payload.entries) ? payload.entries : [];

  if (!date || !driver || !entries.length) {
    return { success: false, message: 'Missing required fields' };
  }

  ensureEntriesSheetSchema_();

  const sheet = getSheet_(SHEETS.ENTRIES);
  const headers = getSheetHeaders_(sheet);
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

  const rows = entries.map(function(item) {
    const amount = toNumber_(item.amount);
    const tipAmount = toNumber_(item.tipAmount);

    if (!String(item.employee || '').trim()) {
      throw new Error('Employee is required');
    }
    if (amount <= 0) {
      throw new Error('Amount must be greater than zero');
    }

    const row = new Array(headers.length).fill('');
    row[headers.indexOf('Date')] = date;
    row[headers.indexOf('Driver')] = driver;
    row[headers.indexOf('Employee')] = String(item.employee || '').trim();
    row[headers.indexOf('PaymentMethod')] = normalizePaymentMethod_(item.paymentMethod);
    row[headers.indexOf('Amount')] = amount;
    row[headers.indexOf('TipAmount')] = tipAmount;
    row[headers.indexOf('Timestamp')] = timestamp;
    return row;
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return { success: true, inserted: rows.length };
}

function getDashboard_(params) {
  const entries = getEntryRecords_();
  const filtered = filterEntries_(entries, params || {});

  const summary = filtered.reduce(function(acc, item) {
    acc.totalRevenue += item.amount;
    acc.totalTips += item.tipAmount;
    acc.totalSessions += 1;
    acc.total += item.amount + item.tipAmount;

    const key = item.paymentMethod.toLowerCase();
    if (key === 'cash') acc.cash += item.amount;
    if (key === 'card') acc.card += item.amount;
    if (key === 'app') acc.app += item.amount;
    if (key === 'wallet') acc.wallet += item.amount;

    return acc;
  }, {
    totalRevenue: 0,
    totalTips: 0,
    totalSessions: 0,
    total: 0,
    cash: 0,
    card: 0,
    app: 0,
    wallet: 0
  });

  const drivers = getObjects_(getSheet_(SHEETS.USERS)).map(function(row) {
    return {
      password: String(row.Password || '').trim(),
      passwordMasked: maskPassword_(String(row.Password || '').trim()),
      role: String(row.Role || '').trim().toLowerCase(),
      driverName: String(row.DriverName || '').trim(),
      status: normalizeStatus_(row.Status)
    };
  }).filter(function(row) {
    return row.role === 'driver';
  });

  return {
    summary: roundMoneyObject_(summary),
    entries: filtered
      .sort(function(a, b) { return String(b.timestamp).localeCompare(String(a.timestamp)); })
      .slice(0, 250)
      .map(function(item) {
        return roundMoneyObject_(item);
      }),
    drivers: drivers
  };
}

function getEmployeeMonthlyRevenue_(params) {
  const entries = getEntryRecords_();
  let filtered = entries;

  const fromDate = String(params.fromDate || '').trim();
  const toDate = String(params.toDate || '').trim();
  const month = String(params.month || '').trim();
  const year = String(params.year || '').trim();

  if (fromDate && toDate) {
    filtered = filtered.filter(function(item) {
      return item.date >= fromDate && item.date <= toDate;
    });
  } else if (month && year) {
    const targetMonth = ('0' + parseInt(month, 10)).slice(-2);
    filtered = filtered.filter(function(item) {
      return item.date && item.date.slice(0, 7) === (year + '-' + targetMonth);
    });
  }

  const map = {};

  filtered.forEach(function(entry) {
    if (!entry.employee) return;

    if (!map[entry.employee]) {
      map[entry.employee] = {
        employee: entry.employee,
        sessions: 0,
        revenue: 0,
        tips: 0,
        cash: 0,
        card: 0,
        app: 0,
        wallet: 0,
        total: 0
      };
    }

    const item = map[entry.employee];
    item.sessions += 1;
    item.revenue += entry.amount;
    item.tips += entry.tipAmount;
    item.total += entry.amount + entry.tipAmount;

    const key = entry.paymentMethod.toLowerCase();
    if (key === 'cash') item.cash += entry.amount;
    else if (key === 'card') item.card += entry.amount;
    else if (key === 'app') item.app += entry.amount;
    else if (key === 'wallet') item.wallet += entry.amount;
  });

  return Object.keys(map)
    .sort()
    .map(function(key) { return roundMoneyObject_(map[key]); });
}

function addDriver_(payload) {
  const driverName = String(payload.driverName || '').trim();
  const password = String(payload.password || '').trim();
  if (!driverName || !password) return { success: false, message: 'Driver name and password are required' };

  const sheet = getSheet_(SHEETS.USERS);
  const rows = getObjects_(sheet);
  if (rows.some(function(row) { return String(row.Password || '').trim() === password; })) {
    return { success: false, message: 'Password already exists' };
  }

  sheet.appendRow([password, 'driver', driverName, 'active']);
  return { success: true };
}

function updateDriver_(payload) {
  const originalPassword = String(payload.originalPassword || '').trim();
  const driverName = String(payload.driverName || '').trim();
  const password = String(payload.password || '').trim();
  if (!originalPassword) return { success: false, message: 'Original driver reference missing' };

  const sheet = getSheet_(SHEETS.USERS);
  const values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === originalPassword) {
      values[i][0] = password;
      values[i][1] = 'driver';
      values[i][2] = driverName;
      values[i][3] = payload.status || values[i][3] || 'active';
      sheet.getRange(i + 1, 1, 1, values[i].length).setValues([values[i]]);
      return { success: true };
    }
  }
  return { success: false, message: 'Driver not found' };
}

function toggleDriverStatus_(payload) {
  const password = String(payload.password || '').trim();
  const status = normalizeStatus_(payload.status);
  const sheet = getSheet_(SHEETS.USERS);
  const values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === password) {
      sheet.getRange(i + 1, 4).setValue(status);
      return { success: true };
    }
  }

  return { success: false, message: 'Driver not found' };
}

function addEmployee_(payload) {
  const name = String(payload.name || '').trim();
  if (!name) return { success: false, message: 'Employee name is required' };

  const sheet = getSheet_(SHEETS.EMPLOYEES);
  const rows = getObjects_(sheet);
  if (rows.some(function(row) { return String(row.Name || '').trim().toLowerCase() === name.toLowerCase(); })) {
    return { success: false, message: 'Employee already exists' };
  }

  sheet.appendRow([name, 'active']);
  return { success: true };
}

function updateEmployee_(payload) {
  const originalName = String(payload.originalName || '').trim();
  const name = String(payload.name || '').trim();
  if (!originalName || !name) return { success: false, message: 'Missing employee data' };

  const sheet = getSheet_(SHEETS.EMPLOYEES);
  const values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === originalName) {
      values[i][0] = name;
      values[i][1] = payload.status || values[i][1] || 'active';
      sheet.getRange(i + 1, 1, 1, 2).setValues([[values[i][0], values[i][1]]]);
      return { success: true };
    }
  }

  return { success: false, message: 'Employee not found' };
}

function toggleEmployeeStatus_(payload) {
  const name = String(payload.name || '').trim();
  const status = normalizeStatus_(payload.status);
  const sheet = getSheet_(SHEETS.EMPLOYEES);
  const values = sheet.getDataRange().getValues();

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0] || '').trim() === name) {
      sheet.getRange(i + 1, 2).setValue(status);
      return { success: true };
    }
  }

  return { success: false, message: 'Employee not found' };
}

function setupSheets() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheetWithHeaders_(spreadsheet, SHEETS.USERS, ['Password', 'Role', 'DriverName', 'Status']);
  ensureSheetWithHeaders_(spreadsheet, SHEETS.EMPLOYEES, ['Name', 'Status']);
  ensureEntriesSheetSchema_();

  const employeesSheet = spreadsheet.getSheetByName(SHEETS.EMPLOYEES);
  if (employeesSheet.getLastRow() === 1) {
    const employees = [
      'Aderson', 'Gerard', 'Maria', 'Feryal', 'Yayat', 'Buthaina', 'Carla', 'Sanaa', 'Mylin',
      'DiDi', 'NooR', 'Latifa', 'RJ', 'Karin', 'MarCo', 'Jeny', 'Toban'
    ].map(function(name) { return [name, 'active']; });

    employeesSheet.getRange(2, 1, employees.length, 2).setValues(employees);
  }
}

function ensureEntriesSheetSchema_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEETS.ENTRIES);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEETS.ENTRIES);
    sheet.getRange(1, 1, 1, ENTRY_HEADERS.length).setValues([ENTRY_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];

  if (!headers.some(String)) {
    sheet.getRange(1, 1, 1, ENTRY_HEADERS.length).setValues([ENTRY_HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }

  const tipIndex = headers.indexOf('TipAmount');
  const timestampIndex = headers.indexOf('Timestamp');

  if (tipIndex === -1) {
    const insertAt = timestampIndex >= 0 ? timestampIndex + 1 : headers.length + 1;
    sheet.insertColumnBefore(insertAt);
    sheet.getRange(1, insertAt).setValue('TipAmount');
  }

  const finalHeaders = getSheetHeaders_(sheet);
  ENTRY_HEADERS.forEach(function(header) {
    if (finalHeaders.indexOf(header) === -1) {
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, sheet.getLastColumn()).setValue(header);
    }
  });

  sheet.setFrozenRows(1);
}

function ensureSheetWithHeaders_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(name);
  }

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    return;
  }

  const currentHeaders = getSheetHeaders_(sheet);
  headers.forEach(function(header) {
    if (currentHeaders.indexOf(header) === -1) {
      sheet.insertColumnAfter(sheet.getLastColumn());
      sheet.getRange(1, sheet.getLastColumn()).setValue(header);
    }
  });
  sheet.setFrozenRows(1);
}

function getEntryRecords_() {
  const sheet = getSheet_(SHEETS.ENTRIES);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0].map(String);
  const index = {};
  headers.forEach(function(header, i) { index[header] = i; });

  return values.slice(1).filter(function(row) {
    return row.join('') !== '';
  }).map(function(row) {
    const paymentMethod = normalizePaymentMethod_(row[index.PaymentMethod]);
    const amount = toNumber_(row[index.Amount]);
    const tipAmount = index.TipAmount === undefined ? 0 : toNumber_(row[index.TipAmount]);
    return {
      date: normalizeDate_(index.Date === undefined ? '' : row[index.Date]),
      driver: String(index.Driver === undefined ? '' : row[index.Driver]).trim(),
      employee: String(index.Employee === undefined ? '' : row[index.Employee]).trim(),
      paymentMethod: paymentMethod,
      amount: amount,
      tipAmount: tipAmount,
      total: amount + tipAmount,
      timestamp: String(index.Timestamp === undefined ? '' : row[index.Timestamp]).trim()
    };
  });
}

function filterEntries_(entries, params) {
  const fromDate = String(params.fromDate || '').trim();
  const toDate = String(params.toDate || '').trim();
  const driver = String(params.driver || '').trim();
  const employee = String(params.employee || '').trim();

  return entries.filter(function(item) {
    if (fromDate && item.date < fromDate) return false;
    if (toDate && item.date > toDate) return false;
    if (driver && item.driver !== driver) return false;
    if (employee && item.employee !== employee) return false;
    return true;
  });
}

function normalizePaymentMethod_(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cash') return 'Cash';
  if (normalized === 'card') return 'Card';
  if (normalized === 'app') return 'App';
  if (normalized === 'wallet') return 'Wallet';
  return String(value || '').trim();
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet: ' + name);
  return sheet;
}

function getObjects_(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(function(row) {
    return row.join('') !== '';
  }).map(function(row) {
    const item = {};
    headers.forEach(function(header, index) {
      item[header] = row[index];
    });
    return item;
  });
}

function getSheetHeaders_(sheet) {
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  return sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(String);
}

function normalizeStatus_(status) {
  return String(status || '').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active';
}

function normalizeDate_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  const text = String(value || '').trim();
  if (!text) return '';

  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }

  return text;
}

function toNumber_(value) {
  const num = Number(value || 0);
  if (isNaN(num)) return 0;
  return Math.round(num * 100) / 100;
}

function roundMoneyObject_(obj) {
  const clone = {};
  Object.keys(obj).forEach(function(key) {
    const value = obj[key];
    clone[key] = typeof value === 'number' ? toNumber_(value) : value;
  });
  return clone;
}

function maskPassword_(password) {
  if (!password) return '';
  if (password.length <= 2) return '*'.repeat(password.length);
  return password.slice(0, 1) + '*'.repeat(password.length - 2) + password.slice(-1);
}
