const { google } = require("googleapis");
require("dotenv").config();

function getRangeCandidates(rawRange) {
  const range = (rawRange || "").trim();

  if (!range) {
    return [];
  }

  const candidates = new Set([range]);

  // Support env values wrapped in quotes by mistake.
  const strippedOuterQuotes = range.replace(/^["'](.*)["']$/, "$1");
  candidates.add(strippedOuterQuotes);

  const [sheetPart, cellsPart] = strippedOuterQuotes.split("!");

  if (sheetPart && cellsPart) {
    const cleanedSheetName = sheetPart.replace(/^'+|'+$/g, "");
    candidates.add(`${cleanedSheetName}!${cellsPart}`);
    candidates.add(`'${cleanedSheetName}'!${cellsPart}`);
  }

  return [...candidates].filter(Boolean);
}

async function getOrdersFromSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });

  const sheets = google.sheets({
    version: "v4",
    auth,
  });

  const rangeCandidates = getRangeCandidates(process.env.GOOGLE_SHEET_RANGE);
  let response;
  let lastError;

  for (const range of rangeCandidates) {
    try {
      response = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range,
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!response) {
    throw lastError;
  }

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0];

  const orders = rows.slice(1).map((row) => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = row[index] || "";
    });

    return item;
  });

  return orders;
}

module.exports = {
  getOrdersFromSheet,
};
