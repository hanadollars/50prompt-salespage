import { kv } from '@vercel/kv';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Xác thực API key từ SePay
  const authHeader = req.headers['authorization'] || '';
  const expectedKey = `Apikey ${process.env.SEPAY_API_KEY}`;
  if (authHeader !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const body = req.body;
    const content = body.content || body.description || '';
    
    // Tìm mã đơn hàng trong nội dung chuyển khoản
    const match = content.match(/50P[A-Z0-9]{4}/i);
    if (!match) {
      return res.status(200).json({ message: 'Không tìm thấy mã đơn hàng' });
    }

    const orderCode = match[0].toUpperCase();
    const orderRaw = await kv.get(`order:${orderCode}`);

    if (!orderRaw) {
      return res.status(200).json({ message: 'Đơn hàng không tồn tại' });
    }

    const order = typeof orderRaw === 'string' ? JSON.parse(orderRaw) : orderRaw;

    if (order.status === 'paid') {
      return res.status(200).json({ message: 'Đơn hàng đã xử lý rồi' });
    }

    // Tạo số hóa đơn tự động
    const invoiceCounter = await kv.incr('invoice_counter');
    const invoiceNumber = `HD-2026-${String(invoiceCounter).padStart(4, '0')}`;

    // Cập nhật trạng thái đơn hàng thành paid
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    order.invoiceNumber = invoiceNumber;
    await kv.set(`order:${orderCode}`, JSON.stringify(order), { ex: 172800 });

    const ebookLink = process.env.EBOOK_LINK;
    const fromEmail = process.env.FROM_EMAIL || 'noreply@hanadola.com';
    const notifyEmail = process.env.NOTIFY_EMAIL;

    // Email 1: Gửi ebook cho khách hàng
    await resend.emails.send({
      from: fromEmail,
      to: order.email,
      subject: `🎉 Cảm ơn bạn! Đây là link tải ebook 50 Prompt AI`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
          <h2 style="color:#f97316;">Xin chào ${order.name}! 👋</h2>
          <p>Thanh toán của bạn đã được xác nhận thành công.</p>
          <p><strong>Mã đơn hàng:</strong> ${orderCode}</p>
          <p><strong>Số tiền:</strong> 149.000₫</p>
          <div style="text-align:center;margin:30px 0;">
            <a href="${ebookLink}" 
               style="background:#f97316;color:white;padding:15px 30px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:bold;">
              📥 TẢI EBOOK NGAY
            </a>
          </div>
          <p style="color:#666;font-size:13px;">Link tải sẽ có hiệu lực trong 7 ngày. Nếu cần hỗ trợ, liên hệ: ${fromEmail}</p>
        </div>
      `
    });

    // Email 2: Hóa đơn điện tử
    await resend.emails.send({
      from: fromEmail,
      to: order.email,
      subject: `🧾 Hóa đơn ${invoiceNumber} - 50 Prompt AI Ebook`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;border:1px solid #ddd;border-radius:8px;">
          <h2 style="color:#1e40af;text-align:center;">HÓA ĐƠN ĐIỆN TỬ</h2>
          <p style="text-align:center;color:#666;">Số hóa đơn: <strong>${invoiceNumber}</strong></p>
          <hr/>
          <table style="width:100%;border-collapse:collapse;">
            <tr><td style="padding:8px;color:#666;">Khách hàng:</td><td style="padding:8px;"><strong>${order.name}</strong></td></tr>
            <tr><td style="padding:8px;color:#666;">Email:</td><td style="padding:8px;">${order.email}</td></tr>
            <tr><td style="padding:8px;color:#666;">Ngày mua:</td><td style="padding:8px;">${new Date().toLocaleDateString('vi-VN')}</td></tr>
            <tr><td style="padding:8px;color:#666;">Sản phẩm:</td><td style="padding:8px;">Ebook 50 Prompt AI</td></tr>
            <tr style="background:#f3f4f6;"><td style="padding:8px;color:#666;">Thành tiền:</td><td style="padding:8px;"><strong style="color:#f97316;">149.000₫</strong></td></tr>
          </table>
          <hr/>
          <p style="text-align:center;color:#666;font-size:12px;">Cảm ơn bạn đã mua hàng tại Hanadola!</p>
        </div>
      `
    });

    // Email 3: Thông báo admin
    if (notifyEmail) {
      await resend.emails.send({
        from: fromEmail,
        to: notifyEmail,
        subject: `💰 Đơn hàng mới: ${orderCode} - 149.000₫`,
        html: `
          <p><strong>Đơn hàng mới thanh toán thành công!</strong></p>
          <p>Mã đơn: ${orderCode}</p>
          <p>Khách hàng: ${order.name}</p>
          <p>Email: ${order.email}</p>
          <p>Số tiền: 149.000₫</p>
          <p>Thời gian: ${new Date().toLocaleString('vi-VN')}</p>
          <p>Hóa đơn: ${invoiceNumber}</p>
        `
      });
    }

    return res.status(200).json({ success: true, invoiceNumber });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Lỗi xử lý webhook' });
  }
}
