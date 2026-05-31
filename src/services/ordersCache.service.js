const googleSheetService = require("./googleSheet.service");

let cachedOrders = [];
let lastFetchTime = 0;

const CACHE_DURATION = 2 * 60 * 1000; // دقيقتين

async function getCachedOrders(forceRefresh = false) {
  const now = Date.now();
  const cacheExpired = now - lastFetchTime > CACHE_DURATION;

  if (!forceRefresh && cachedOrders.length > 0 && !cacheExpired) {
    return cachedOrders;
  }

  cachedOrders = await googleSheetService.getOrdersFromSheet();
  lastFetchTime = now;

  return cachedOrders;
}

module.exports = {
  getCachedOrders,
};
