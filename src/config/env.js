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
  },
};
