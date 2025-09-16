const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = 3001;

// Middleware otimizado
app.use(cors({
  origin: "*"
}));

app.use(express.json({ limit: '10mb' }));

// Middleware de logs simplificado
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Health check otimizado
app.get('/health', async (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Servidor está funcionando',
        timestamp: new Date().toISOString()
    });
});

// Rota para listar todos os usuários (com paginação) - CORRIGIDA
app.get('/users', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        console.log('Buscando usuários...');

        // Buscar usuários - consulta simplificada e corrigida
        const users = await prisma.user.findMany({
            skip: skip,
            take: limit,
            select: {
                id: true,
                mobile: true,
                invitation_code: true,
                created_at: true,
                // Removida a relação inviter que pode estar causando problemas
            },
            orderBy: {
                created_at: 'desc'
            }
        });

        console.log(`Encontrados ${users.length} usuários`);

        // Contar total de usuários
        const totalUsers = await prisma.user.count();

        res.status(200).json({
            success: true,
            data: {
                users,
                pagination: {
                    page,
                    limit,
                    total: totalUsers,
                    pages: Math.ceil(totalUsers / limit)
                }
            }
        });

    } catch (error) {
        console.error('Erro ao buscar usuários:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor',
            error: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// Rota para buscar estatísticas dos usuários
app.get('/users/stats', async (req, res) => {
    try {
        // Total de usuários
        const totalUsers = await prisma.user.count();
        
        // Usuários cadastrados hoje
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayUsers = await prisma.user.count({
            where: {
                created_at: {
                    gte: today
                }
            }
        });
        
        // Usuários com código de indicação
        const usersWithInviter = await prisma.user.count({
            where: {
                NOT: {
                    inviter_id: null
                }
            }
        });

        res.status(200).json({
            success: true,
            data: {
                totalUsers,
                todayUsers,
                usersWithInviter
            }
        });

    } catch (error) {
        console.error('Erro ao buscar estatísticas:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para buscar um usuário específico
app.get('/users/:id', async (req, res) => {
    try {
        const userId = req.params.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                invitation_code: true,
                created_at: true,
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.status(200).json({
            success: true,
            data: user
        });

    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota de login administrativo simplificado
app.post('/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        // Verificação simplificada para admin
        if (username === '0000' && password === '0000') {
            // Gerar token JWT para admin
            const token = jwt.sign(
                { role: 'admin' }, 
                process.env.JWT_SECRET || 'admin_segredo_jwt', 
                { expiresIn: '1h' }
            );

            res.json({
                success: true,
                message: 'Login administrativo realizado com sucesso',
                data: { token }
            });
        } else {
            res.status(401).json({
                success: false,
                message: 'Credenciais administrativas inválidas'
            });
        }

    } catch (error) {
        console.error('Erro no login administrativo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota simples para testar o Prisma
app.get('/test-db', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            take: 5,
            select: { id: true, mobile: true }
        });
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar servidor com otimizações
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor de administração rodando na porta ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Teste de usuários: http://localhost:${PORT}/users`);
    
    // Testar conexão com banco
    prisma.$connect()
        .then(() => console.log('Conectado ao banco de dados'))
        .catch(err => console.error('Erro na conexão com o banco:', err));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});