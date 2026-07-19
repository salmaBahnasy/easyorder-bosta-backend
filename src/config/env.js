require("dotenv").config();

module.exports = {
  port: process.env.PORT || 5050,

  easyorder: {
    apiKey: process.env.EASYORDER_API_KEY,
    baseUrl: process.env.EASYORDER_BASE_URL,
  },

  easyconfirm: {
    apiKey: process.env.EASYCONFIRM_API_KEY,
    baseUrl:
      process.env.EASYCONFIRM_API_BASE_URL ||
      "https://api.easyconfirm.net/api/v1",
    webhookSecret: process.env.EASYCONFIRM_WEBHOOK_SECRET,
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
