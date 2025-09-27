const express = require('express');
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const { cloudinary } = require('./cloudinary'); // apenas cloudinary
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const router = express.Router();

// Configuração do CloudinaryStorage
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'deposit_receipts',
    format: async (req, file) => {
      const ext = file.originalname.split('.').pop().toLowerCase();
      return ext === 'jpg' || ext === 'jpeg' ? 'jpg' : 'png';
    },
    public_id: (req, file) => {
      const timestamp = Date.now();
      const random = Math.random().toString(36).substring(7);
      return `deposit_${req.user.id}_${timestamp}_${random}`;
    }
  },
});

// Configuração do Multer
const parser = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Apenas imagens são permitidas!'), false);
  }
});

// Upload de imagem de perfil
router.post('/upload', parser.single('image'), async (req, res) => {
  try {
    if (!req.file || !req.file.path) {
      return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada' });
    }

    const imageUrl = req.file.path;

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { head_img: imageUrl }
    });

    res.json({ success: true, imageUrl, user: updatedUser });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Erro ao enviar imagem' });
  }
});

console.log("Cloudinary vars:", {
  name: process.env.CLOUDINARY_CLOUD_NAME,
  key: process.env.CLOUDINARY_API_KEY ? "OK" : "MISSING",
  secret: process.env.CLOUDINARY_API_SECRET ? "OK" : "MISSING"
});


// Upload de comprovante de depósito
router.post('/deposit-receipt', parser.single('receipt'), async (req, res) => {
  try {
    const { deposit_id } = req.body;

    if (!deposit_id) {
      return res.status(400).json({ success: false, message: 'ID do depósito é obrigatório' });
    }

    if (!req.file || !req.file.path) {
      return res.status(400).json({ success: false, message: 'Nenhuma imagem enviada' });
    }

    const receiptUrl = req.file.path;

    // Verificar se o depósito pertence ao usuário
    const deposit = await prisma.deposit.findFirst({
      where: { id: deposit_id, user_id: req.user.id }
    });

    if (!deposit) {
      return res.status(404).json({ success: false, message: 'Depósito não encontrado' });
    }

    const updatedDeposit = await prisma.deposit.update({
      where: { id: deposit_id },
      data: { receipt_image: receiptUrl, updated_at: new Date() }
    });

    await prisma.systemLog.create({
      data: {
        action: 'DEPOSIT_RECEIPT_UPLOADED',
        description: `Comprovante enviado para depósito ${deposit_id}`,
        user_id: req.user.id,
        created_at: new Date()
      }
    });

    res.json({
      success: true,
      receiptUrl,
      deposit: updatedDeposit,
      message: 'Comprovante enviado com sucesso'
    });
  } catch (err) {
    console.error(err);

    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'Arquivo muito grande. Máximo 5MB.' });
    }

    res.status(500).json({ success: false, message: 'Erro ao enviar comprovante' });
  }
});

// Listar comprovantes do usuário
router.get('/user-receipts', async (req, res) => {
  try {
    const userId = req.user.id;

    const deposits = await prisma.deposit.findMany({
      where: { user_id: userId, receipt_image: { not: null } },
      select: {
        id: true,
        amount: true,
        bank_name: true,
        receipt_image: true,
        created_at: true,
        status: true
      },
      orderBy: { created_at: 'desc' }
    });

    res.json({ success: true, data: deposits });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Erro ao buscar comprovantes' });
  }
});

module.exports = router;
