require("dotenv").config();

module.exports = {
  port: process.env.PORT || 5050,

  easyorder: {
    apiKey: process.env.EASYORDER_API_KEY,
    baseUrl: process.env.EASYORDER_BASE_URL,
  },

  bosta: {
    apiKey: process.env.BOSTA_API_KEY,
    baseUrl: process.env.BOSTA_BASE_URL,
    fulfillmentBaseUrl:
      process.env.BOSTA_FULFILLMENT_BASE_URL ||
      "https://api-fulfillment.bosta.co/api/v1",
    webhookUrl: process.env.BOSTA_WEBHOOK_URL,
    fulfillmentApiKey: process.env.BOSTA_FULFILLMENT_API_KEY,
  },
};
