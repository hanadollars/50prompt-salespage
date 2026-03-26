// api/sepay-webhook.js
// SePay gọi endpoint này mỗi khi nhận được giao dịch vào tài khoản ACB
// Tài liệu: https://docs.sepay.vn/webhook

import { kv } from '@vercel/kv';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── 1. Xác thực chữ ký SePay ────────────────────────────────
  const authHeader = req.headers['authorization'] || '';
  const expectedKey = `Apikey ${process.env.SEPAY_API_KEY}`;
  if (authHeader !== expectedKey) {
    console.error('[WEBHOOK] Unauthorized request');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  // ── 2. Đọc payload từ SePay ──────────────────────────────────
  const {
    id,                  // ID giao dịch SePay
    content,             // Nội dung chuyển khoản
    transferAmount,      // Số tiền nhận được
    transferType,        // 'in' = tiền vào, 'out' = tiền ra
    referenceCode,       // Mã tham chiếu ngân hàng
    transactionDate,     // Thời gian giao dịch
    accountNumber,       // Số TK nhận
  } = req.body;

  console.log('[WEBHOOK] Received:', { id, content, transferAmount, transferType });

  // Chỉ xử lý giao dịch tiền VÀO
  if (transferType !== 'in') {
    return res.status(200).json({ success: true, message: 'Ignored outgoing transaction' });
  }

  // ── 3. Tìm mã đơn hàng trong nội dung CK ────────────────────
  // Nội dung CK dạng: "EBOOK50P 50PABCD" hoặc có thêm text khác
  const match = (content || '').match(/50P[A-Z0-9]{4}/i);
  if (!match) {
    console.log('[WEBHOOK] No order code found in content:', content);
    return res.status(200).json({ success: true, message: 'No matching order code' });
  }

  const orderCode = match[0].toUpperCase();
  console.log('[WEBHOOK] Order code:', orderCode);

  // ── 4. Tìm đơn hàng trong KV ────────────────────────────────
  const order = await kv.get(`order:${orderCode}`);
  if (!order) {
    console.error('[WEBHOOK] Order not found:', orderCode);
    return res.status(200).json({ success: true, message: 'Order not found' });
  }

  if (order.status === 'paid') {
    console.log('[WEBHOOK] Order already paid:', orderCode);
    return res.status(200).json({ success: true, message: 'Already processed' });
  }

  // ── 5. Kiểm tra số tiền ─────────────────────────────────────
  if (parseInt(transferAmount) < order.amount) {
    console.error('[WEBHOOK] Insufficient amount:', transferAmount, '<', order.amount);
    // Thông báo admin nhưng không hủy
    await sendAdminAlert(order, transferAmount, referenceCode);
    return res.status(200).json({ success: true, message: 'Insufficient amount - admin notified' });
  }

  // ── 6. Tạo số hóa đơn điện tử ───────────────────────────────
  const invoiceNo = await generateInvoiceNo();
  const paidAt    = transactionDate || new Date().toISOString();

  // ── 7. Cập nhật đơn hàng trong KV ───────────────────────────
  const updatedOrder = {
    ...order,
    status:          'paid',
    invoiceNo,
    paidAt,
    sePayId:         id,
    referenceCode,
    transferAmount,
  };
  await kv.set(`order:${orderCode}`, updatedOrder, { ex: 2592000 }); // 30 ngày

  // ── 8. Gửi email cho khách hàng ─────────────────────────────
  await sendCustomerEmail(updatedOrder);

  // ── 9. Gửi hóa đơn điện tử ──────────────────────────────────
  await sendInvoiceEmail(updatedOrder);

  // ── 10. Thông báo admin ──────────────────────────────────────
  await sendAdminNotification(updatedOrder, referenceCode);

  // ── 11. (Tùy chọn) Gửi hóa đơn lên nhà cung cấp e-Invoice ──
  // Uncomment và điền API của nhà cung cấp bạn dùng (VNPT, Viettel, MISA...)
  // await submitEInvoice(updatedOrder);

  console.log('[WEBHOOK] Order processed successfully:', orderCode);
  return res.status(200).json({ success: true, message: 'Processed', orderCode });
}

// ════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

/** Tạo số hóa đơn tự tăng dạng HD-2026-0001 */
async function generateInvoiceNo() {
  const year    = new Date().getFullYear();
  const key     = `invoice_counter:${year}`;
  const counter = await kv.incr(key);
  await kv.expire(key, 400 * 24 * 3600); // hết hạn sau ~400 ngày
  return `HD-${year}-${String(counter).padStart(4, '0')}`;
}

/** Email gửi cho khách — có link tải ebook */
async function sendCustomerEmail(order) {
  const ebookLink = process.env.EBOOK_LINK;
  try {
    await resend.emails.send({
      from:    `Hanadola Media <${process.env.FROM_EMAIL || 'no-reply@hanadola.com'}>`,
      to:      order.email,
      subject: `✅ Đơn hàng ${order.code} đã thanh toán — Link tải ebook của bạn`,
      html: `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0F0007;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px">
    <!-- Header -->
    <div style="background:linear-gradient(135deg,#A8174C,#7B2D8B);border-radius:16px 16px 0 0;padding:32px;text-align:center">
      <div style="font-size:48px;margin-bottom:12px">🎉</div>
      <h1 style="color:#fff;font-size:22px;margin:0 0 8px">Thanh toán thành công!</h1>
      <p style="color:rgba(255,200,220,0.8);font-size:14px;margin:0">Cảm ơn bạn đã mua sản phẩm của Hanadola</p>
    </div>

    <!-- Body -->
    <div style="background:#1E0014;padding:28px;border-radius:0 0 16px 16px;border:1px solid rgba(214,51,132,0.2)">
      <p style="color:rgba(255,220,235,0.9);font-size:15px;margin:0 0 20px">
        Xin chào <strong style="color:#FF6EB5">${order.name}</strong>,
      </p>
      <p style="color:rgba(255,200,220,0.75);font-size:14px;line-height:1.7;margin:0 0 24px">
        Đơn hàng <strong>#${order.code}</strong> của bạn đã được xác nhận.<br>
        Nhấn nút bên dưới để tải ngay <strong>50 Prompt Tạo Ảnh AI Phong Cách</strong>.
      </p>

      <!-- Download Button -->
      <div style="text-align:center;margin:28px 0">
        <a href="${ebookLink}" target="_blank"
           style="background:linear-gradient(135deg,#FF6EB5,#D63384);color:#fff;
                  text-decoration:none;font-size:16px;font-weight:800;
                  padding:16px 36px;border-radius:100px;display:inline-block;
                  box-shadow:0 8px 24px rgba(168,23,76,0.4)">
          📥 Tải eBook PDF Ngay
        </a>
      </div>

      <!-- Order Info -->
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(214,51,132,0.15);border-radius:12px;padding:16px 20px;margin-bottom:20px">
        <p style="font-size:13px;font-weight:700;color:rgba(255,200,220,0.5);margin:0 0 12px;letter-spacing:1px;text-transform:uppercase">Chi tiết đơn hàng</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="font-size:13px;color:rgba(255,200,220,0.6);padding:5px 0">Mã đơn hàng</td><td style="font-size:13px;color:#FFE0EE;font-weight:600;text-align:right">#${order.code}</td></tr>
          <tr><td style="font-size:13px;color:rgba(255,200,220,0.6);padding:5px 0">Sản phẩm</td><td style="font-size:13px;color:#FFE0EE;font-weight:600;text-align:right">${order.product}</td></tr>
          <tr><td style="font-size:13px;color:rgba(255,200,220,0.6);padding:5px 0">Số tiền</td><td style="font-size:13px;color:#FF6EB5;font-weight:800;text-align:right">149.000 ₫</td></tr>
          <tr><td style="font-size:13px;color:rgba(255,200,220,0.6);padding:5px 0">Số hóa đơn</td><td style="font-size:13px;color:#FFD700;font-weight:600;text-align:right">${order.invoiceNo}</td></tr>
        </table>
      </div>

      <div style="background:rgba(255,215,0,0.08);border-left:3px solid #C9973A;border-radius:8px;padding:12px 16px;font-size:13px;color:rgba(255,215,0,0.8);line-height:1.6">
        💡 <strong>Lưu ý:</strong> Link tải có thể yêu cầu đăng nhập Google. Hóa đơn điện tử sẽ được gửi riêng trong email tiếp theo.
      </div>

      <p style="font-size:12px;color:rgba(255,200,220,0.3);margin:24px 0 0;text-align:center">
        Cần hỗ trợ? Liên hệ <a href="https://www.hanadola.com" style="color:#D63384">www.hanadola.com</a><br>
        © 2026 Hanadola Media &amp; Technology
      </p>
    </div>
  </div>
</body>
</html>`,
    });
    console.log('[EMAIL] Customer email sent to:', order.email);
  } catch (err) {
    console.error('[EMAIL] Failed to send customer email:', err);
  }
}

/** Email hóa đơn điện tử cho khách */
async function sendInvoiceEmail(order) {
  const invoiceDate = new Date(order.paidAt).toLocaleDateString('vi-VN');
  try {
    await resend.emails.send({
      from:    `Hanadola Media <${process.env.FROM_EMAIL || 'no-reply@hanadola.com'}>`,
      to:      order.email,
      subject: `🧾 Hóa đơn ${order.invoiceNo} — Hanadola Media & Technology`,
      html: `
<!DOCTYPE html>
<html lang="vi">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
    <!-- Invoice Header -->
    <div style="background:linear-gradient(135deg,#A8174C,#7B2D8B);padding:28px 32px;display:flex;justify-content:space-between;align-items:center">
      <div>
        <h1 style="color:#fff;font-size:20px;margin:0 0 4px;font-weight:800">HÓA ĐƠN ĐIỆN TỬ</h1>
        <p style="color:rgba(255,200,220,0.8);font-size:13px;margin:0">Hanadola Media &amp; Technology</p>
      </div>
      <div style="text-align:right">
        <div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:10px 16px">
          <p style="color:#FFD700;font-size:18px;font-weight:800;margin:0">${order.invoiceNo}</p>
          <p style="color:rgba(255,200,220,0.7);font-size:11px;margin:4px 0 0">Ngày: ${invoiceDate}</p>
        </div>
      </div>
    </div>

    <!-- Invoice Body -->
    <div style="padding:28px 32px">
      <!-- Seller Info -->
      <div style="margin-bottom:20px;padding:16px;background:#f9f0ff;border-radius:10px;border-left:4px solid #A8174C">
        <p style="font-size:12px;font-weight:700;color:#888;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase">Người bán</p>
        <p style="font-size:14px;font-weight:800;color:#1a0010;margin:0 0 4px">HANADOLA MEDIA &amp; TECHNOLOGY</p>
        <p style="font-size:13px;color:#555;margin:0">Website: www.hanadola.com</p>
      </div>

      <!-- Buyer Info -->
      <div style="margin-bottom:24px;padding:16px;background:#f9f9f9;border-radius:10px">
        <p style="font-size:12px;font-weight:700;color:#888;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase">Người mua</p>
        <p style="font-size:14px;font-weight:700;color:#1a1a1a;margin:0 0 2px">${order.name}</p>
        <p style="font-size:13px;color:#555;margin:0">${order.email}</p>
        ${order.phone ? `<p style="font-size:13px;color:#555;margin:2px 0 0">${order.phone}</p>` : ''}
      </div>

      <!-- Items Table -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
        <thead>
          <tr style="background:linear-gradient(135deg,#A8174C,#7B2D8B)">
            <th style="padding:12px 14px;font-size:12px;font-weight:700;color:#fff;text-align:left;border-radius:8px 0 0 0">Sản phẩm</th>
            <th style="padding:12px 14px;font-size:12px;font-weight:700;color:#fff;text-align:center">SL</th>
            <th style="padding:12px 14px;font-size:12px;font-weight:700;color:#fff;text-align:right;border-radius:0 8px 0 0">Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          <tr style="background:#fff;border-bottom:1px solid #eee">
            <td style="padding:14px;font-size:13px;color:#1a1a1a">
              <strong>${order.product}</strong><br>
              <span style="font-size:11px;color:#888">File PDF · Sở hữu trọn đời · Hanadola Media</span>
            </td>
            <td style="padding:14px;font-size:13px;color:#1a1a1a;text-align:center">1</td>
            <td style="padding:14px;font-size:14px;font-weight:800;color:#A8174C;text-align:right">149.000 ₫</td>
          </tr>
        </tbody>
        <tfoot>
          <tr style="background:#f9f0ff">
            <td colspan="2" style="padding:14px;font-size:13px;font-weight:700;color:#555">Tổng cộng (đã bao gồm VAT 10%)</td>
            <td style="padding:14px;font-size:18px;font-weight:900;color:#A8174C;text-align:right">149.000 ₫</td>
          </tr>
        </tfoot>
      </table>

      <!-- Payment Info -->
      <div style="background:#f0fff4;border:1px solid #86efac;border-radius:10px;padding:14px 16px;margin-bottom:20px">
        <p style="font-size:12px;font-weight:700;color:#166534;margin:0 0 6px;text-transform:uppercase;letter-spacing:1px">✅ Đã thanh toán</p>
        <p style="font-size:13px;color:#374151;margin:0">Phương thức: Chuyển khoản ACB · Mã tham chiếu: <strong>${order.referenceCode || order.code}</strong></p>
      </div>

      <p style="font-size:11px;color:#aaa;text-align:center;margin:0">
        Hóa đơn này được tạo tự động bởi hệ thống Hanadola Media &amp; Technology.<br>
        Mọi thắc mắc vui lòng liên hệ: <a href="mailto:${process.env.NOTIFY_EMAIL}" style="color:#A8174C">${process.env.NOTIFY_EMAIL}</a>
      </p>
    </div>
  </div>
</body>
</html>`,
    });
    console.log('[INVOICE] Invoice email sent:', order.invoiceNo);
  } catch (err) {
    console.error('[INVOICE] Failed to send invoice email:', err);
  }
}

/** Thông báo admin khi có đơn hàng mới */
async function sendAdminNotification(order, refCode) {
  try {
    await resend.emails.send({
      from:    `SePay Bot <${process.env.FROM_EMAIL || 'no-reply@hanadola.com'}>`,
      to:      process.env.NOTIFY_EMAIL,
      subject: `💰 Đơn hàng mới #${order.code} — 149.000 ₫`,
      html: `
<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
  <h2 style="color:#A8174C">💰 Đơn hàng mới thanh toán thành công!</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Mã đơn</td><td style="padding:8px;border-bottom:1px solid #eee;font-weight:bold">#${order.code}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Số hóa đơn</td><td style="padding:8px;border-bottom:1px solid #eee;color:#A8174C;font-weight:bold">${order.invoiceNo}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Khách hàng</td><td style="padding:8px;border-bottom:1px solid #eee">${order.name}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Email</td><td style="padding:8px;border-bottom:1px solid #eee">${order.email}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">SĐT</td><td style="padding:8px;border-bottom:1px solid #eee">${order.phone || '—'}</td></tr>
    <tr><td style="padding:8px;border-bottom:1px solid #eee;color:#888">Số tiền</td><td style="padding:8px;border-bottom:1px solid #eee;color:green;font-weight:bold">${order.transferAmount?.toLocaleString('vi-VN')} ₫</td></tr>
    <tr><td style="padding:8px;color:#888">Mã tham chiếu</td><td style="padding:8px">${refCode || '—'}</td></tr>
  </table>
  <p style="font-size:12px;color:#aaa;margin-top:16px">Email tự động từ hệ thống SePay Webhook</p>
</div>`,
    });
  } catch (err) {
    console.error('[ADMIN] Failed to send admin notification:', err);
  }
}

/** Cảnh báo admin khi số tiền không đủ */
async function sendAdminAlert(order, received, refCode) {
  try {
    await resend.emails.send({
      from:    `SePay Bot <${process.env.FROM_EMAIL || 'no-reply@hanadola.com'}>`,
      to:      process.env.NOTIFY_EMAIL,
      subject: `⚠️ Thanh toán thiếu tiền — Đơn #${order.code}`,
      html: `<p>Đơn hàng <b>#${order.code}</b> nhận được <b>${received} ₫</b> nhưng cần <b>${order.amount} ₫</b>.<br>Mã tham chiếu: ${refCode || '—'}<br>Khách: ${order.name} — ${order.email}</p>`,
    });
  } catch (err) {
    console.error('[ADMIN] Alert email failed:', err);
  }
}

/*
 * ════════════════════════════════════════════════════════════════
 * (TÙY CHỌN) Tích hợp hóa đơn điện tử với nhà cung cấp
 * ════════════════════════════════════════════════════════════════
 * Uncomment và điền API key của nhà cung cấp bạn chọn:
 * - VNPT e-Invoice: https://einvoice.vnpt.vn
 * - Viettel e-Invoice: https://einvoice.viettel.vn
 * - MISA: https://einvoice.misa.com.vn
 *
async function submitEInvoice(order) {
  const payload = {
    invoiceType: '01GTKT',           // Loại hóa đơn
    invoiceNo:    order.invoiceNo,
    issueDate:    order.paidAt,
    buyer: {
      name:  order.name,
      email: order.email,
    },
    items: [{
      name:     order.product,
      quantity: 1,
      price:    135454,             // Giá chưa VAT 10% (149000 / 1.1)
      vat:      10,
      amount:   149000,
    }],
    totalAmount:    149000,
    totalVatAmount: 13545,
  };

  const resp = await fetch(process.env.EINVOICE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.EINVOICE_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const result = await resp.json();
  console.log('[EINVOICE] Result:', result);
  return result;
}
*/
