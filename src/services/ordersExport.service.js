const XLSX = require("xlsx");

function parseCartLines(order) {
  const lines = order?.cart_items ?? order?.cartItems;
  return Array.isArray(lines) ? lines : [];
}

function lineProductName(line) {
  const product =
    line?.product && typeof line.product === "object" ? line.product : {};
  return String(line?.name || line?.product_name || product?.name || "").trim();
}

function formatProductsCell(order) {
  return parseCartLines(order)
    .map((line) => {
      const name = lineProductName(line) || "منتج";
      const qty = Math.max(1, Number(line?.quantity) || 1);
      return `${name} x${qty}`;
    })
    .join(" | ");
}

function formatSizesCell(order) {
  return parseCartLines(order)
    .map((line) => {
      const variant =
        line?.variant && typeof line.variant === "object" ? line.variant : {};
      return String(variant?.size ?? line?.size ?? "").trim();
    })
    .filter(Boolean)
    .join(" | ");
}

function formatBostaSkusCell(order) {
  return parseCartLines(order)
    .map((line) => {
      const variant =
        line?.variant && typeof line.variant === "object" ? line.variant : {};
      return String(
        line?.bosta_sku ??
          line?.bostaSku ??
          variant?.bosta_sku ??
          variant?.sku ??
          "",
      ).trim();
    })
    .filter(Boolean)
    .join(" | ");
}

function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return n;
}

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString();
}

function orderToExportRow(order) {
  return {
    "رقم الطلب": order.order_reference ?? order.orderReference ?? "",
    "معرف الطلب": order.sourceOrderId ?? order.id ?? "",
    "اسم العميل": order.full_name ?? order.firstName ?? order.customer_name ?? "",
    "الهاتف": order.phone ?? order.mobile ?? "",
    "هاتف 2": order.phone2 ?? order.secondaryPhone ?? "",
    "العنوان": order.address ?? order.firstLine ?? "",
    "المدينة": order.city ?? order.government ?? "",
    "الحي": order.district ?? order.area ?? "",
    "حالة الطلب": order.status ?? order.orderStatus ?? "",
    "مصدر الطلب": order.order_source ?? order.orderSource ?? "",
    "نوع الطلب": order.order_type ?? order.orderType ?? "",
    "حالة الشحن": order.shipping_status ?? order.shippingStatus ?? "",
    "الإجمالي": formatMoney(
      order.total_cost ?? order.totalCost ?? order.total ?? order.cost,
    ),
    "المنتجات": formatProductsCell(order),
    "المقاس": formatSizesCell(order),
    "SKU بوسطة": formatBostaSkusCell(order),
    "مدينة بوسطة": order.bosta_city_id ?? order.bostaCityId ?? "",
    "حي بوسطة": order.bosta_district_id ?? order.bostaDistrictId ?? "",
    "تاريخ الإنشاء": formatDateTime(order.receivedAt ?? order.created_at),
  };
}

function buildOrdersExcelBuffer(orders) {
  const rows = (orders || []).map(orderToExportRow);
  const worksheet = XLSX.utils.json_to_sheet(
    rows.length ? rows : [orderToExportRow({})],
  );
  worksheet["!cols"] = [
    { wch: 12 },
    { wch: 38 },
    { wch: 24 },
    { wch: 14 },
    { wch: 14 },
    { wch: 36 },
    { wch: 16 },
    { wch: 16 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 14 },
    { wch: 10 },
    { wch: 40 },
    { wch: 12 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 22 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Orders");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

module.exports = {
  orderToExportRow,
  buildOrdersExcelBuffer,
};
