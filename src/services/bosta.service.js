const axios = require("axios");
const { bosta } = require("../config/env");

function mapOrderToBostaShipment(order) {
  return {
    type: 10,
    specs: {
      packageType: "Parcel",
      size: "MEDIUM",
      packageDetails: {
        itemsCount: 1,
        description: "Order from EasyOrder",
      },
    },
    cod: order.total || 0,
    dropOffAddress: {
      city: order.city,
      zone: order.zone,
      district: order.district,
      firstLine: order.address,
    },
    receiver: {
      firstName: order.customerName || "Customer",
      phone: order.phone,
    },
    notes: order.notes || "",
  };
}

async function createShipment(order) {
  const payload = mapOrderToBostaShipment(order);

  const response = await axios.post(`${bosta.baseUrl}/deliveries`, payload, {
    headers: {
      Authorization: bosta.apiKey,
      "Content-Type": "application/json",
    },
  });

  return response.data;
}

module.exports = {
  createShipment,
};
