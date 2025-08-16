const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { iniciarCronRendimentos } = require('./rendimento');
const router = express.Router();

const prisma = new PrismaClient();
const app = express();
const PORT = 3000;

// Middleware para permitir requisições externas e interpretar body
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Middleware para autenticar token
function autenticarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ code: 401, msg: "Token não fornecido" });
    }

    jwt.verify(token, "seuSegredoJWT", (err, user) => {
        if (err) {
            return res.status(403).json({ code: 403, msg: "Token inválido" });
        }
        req.user = user;
        next();
    });
}

// Função para gerar código de convite aleatório
function gerarCodigoConvite() {
    const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let codigo = '';
    for (let i = 0; i < 8; i++) {
        codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
    }
    return codigo;
}

// Função auxiliar para obter nome do banco
function getBankName(bankCode) {
    const banks = {
        'BFA': 'Banco de Fomento Angola',
        'BAI': 'Banco Angolano de Investimentos',
        'BIC': 'Banco BIC',
        'ATL': 'Banco Atlântico'
    };
    return banks[bankCode] || bankCode;
}

// Rotas de autenticação e usuário
app.post("/usuarios", async (req, res) => {
    try {
        const { mobile, password, inviteCode } = req.body;

        if (!mobile || !password || !inviteCode) {
            return res.status(400).json({ code: 400, msg: "Preencha todos os campos" });
        }

        const convidadoPor = await prisma.usuario.findUnique({
            where: { codigoConvite: inviteCode }
        });

        if (!convidadoPor) {
            return res.status(400).json({ 
                code: 400, 
                msg: "Código de convite inválido" 
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const codigoConviteUsuario = gerarCodigoConvite();

        const novoUsuario = await prisma.usuario.create({
            data: {
                mobile,
                password: hashedPassword,
                codigoConvite: codigoConviteUsuario,
                convidadoPorId: inviteCode,
                saldo: 0
            }
        });

        await prisma.usuario.update({
            where: { codigoConvite: inviteCode },
            data: { 
                saldo: {
                    increment: 0
                } 
            }
        });

        res.status(200).json({
            code: 200,
            msg: "Registro realizado com sucesso",
            redirect: "/index",
            codigoConvite: codigoConviteUsuario,
            saldo: 0
        });

    } catch (error) {
        console.error(error);
        
        if (error.code === 'P2002') {
            if (error.meta?.target?.includes('mobile')) {
                return res.status(409).json({ 
                    code: 409, 
                    msg: "Este número de celular já está cadastrado" 
                });
            }
        }
        
        res.status(500).json({ 
            code: 500, 
            msg: "Erro interno no servidor",
            error: error.message 
        });
    }
});

app.post("/login", async (req, res) => {
    try {
        const { mobile, password } = req.body;

        if (!mobile || !password) {
            return res.status(400).json({ code: 400, msg: "Preencha todos os campos" });
        }

        const usuario = await prisma.usuario.findUnique({
            where: { mobile },
            select: {
                id: true,
                mobile: true,
                password: true,
                codigoConvite: true,
                saldo: true
            }
        });

        if (!usuario) {
            return res.status(401).json({ code: 401, msg: "Usuário não encontrado" });
        }

        const senhaCorreta = await bcrypt.compare(password, usuario.password);
        if (!senhaCorreta) {
            return res.status(401).json({ code: 401, msg: "Senha incorreta" });
        }

        const token = jwt.sign(
            { 
                id: usuario.id, 
                mobile: usuario.mobile,
                codigoConvite: usuario.codigoConvite
            },
            "seuSegredoJWT",
            { expiresIn: "7d" }
        );

        delete usuario.password;

        res.json({
            code: 200,
            msg: "Login realizado com sucesso",
            token,
            usuario
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ code: 500, msg: "Erro interno no servidor" });
    }
});

// Rotas protegidas por autenticação
app.get("/me", autenticarToken, async (req, res) => {
    try {
        const usuario = await prisma.usuario.findUnique({
            where: { id: req.user.id },
            select: {
                mobile: true,
                codigoConvite: true,
                saldo: true
            }
        });

        if (!usuario) {
            return res.status(404).json({ code: 404, msg: "Usuário não encontrado" });
        }

        res.json(usuario);

    } catch (error) {
        console.error(error);
        res.status(500).json({ code: 500, msg: "Erro interno no servidor" });
    }
});

// Rotas de investimento
app.post("/investir", autenticarToken, async (req, res) => {
    try {
        const { nome, preco, rendaDiaria, validadeDias } = req.body;
        const usuarioId = req.user.id;

        const usuario = await prisma.usuario.findUnique({
            where: { id: usuarioId }
        });

        if (!usuario) {
            return res.status(404).json({ code: 404, msg: "Usuário não encontrado" });
        }

        if (usuario.saldo < preco) {
            return res.status(400).json({ code: 400, msg: "Saldo insuficiente" });
        }

        const dataExpiracao = new Date();
        dataExpiracao.setDate(dataExpiracao.getDate() + parseInt(validadeDias));

        const investimento = await prisma.investimento.create({
            data: {
                nome,
                preco,
                rendaDiaria,
                validadeDias,
                dataCompra: new Date(),
                dataExpiracao: dataExpiracao,
                usuarioId
            }
        });

        await prisma.usuario.update({
            where: { id: usuarioId },
            data: { saldo: { decrement: preco } }
        });

        await prisma.historico.create({
            data: {
                usuarioId,
                valor: -preco,
                descricao: `Compra do produto ${nome}`
            }
        });

        if (usuario.convidadoPorId) {
            const nivel1 = await prisma.usuario.findUnique({
                where: { codigoConvite: usuario.convidadoPorId }
            });

            if (nivel1) {
                const bonusNivel1 = preco * 0.20;
                await prisma.usuario.update({
                    where: { id: nivel1.id },
                    data: { saldo: { increment: bonusNivel1 } }
                });

                await prisma.historico.create({
                    data: {
                        usuarioId: nivel1.id,
                        valor: bonusNivel1,
                        descricao: `Bônus de indicação nível 1 (${usuario.mobile})`
                    }
                });

                if (nivel1.convidadoPorId) {
                    const nivel2 = await prisma.usuario.findUnique({
                        where: { codigoConvite: nivel1.convidadoPorId }
                    });

                    if (nivel2) {
                        const bonusNivel2 = preco * 0.05;
                        await prisma.usuario.update({
                            where: { id: nivel2.id },
                            data: { saldo: { increment: bonusNivel2 } }
                        });

                        await prisma.historico.create({
                            data: {
                                usuarioId: nivel2.id,
                                valor: bonusNivel2,
                                descricao: `Bônus de indicação nível 2 (${usuario.mobile})`
                            }
                        });

                        if (nivel2.convidadoPorId) {
                            const nivel3 = await prisma.usuario.findUnique({
                                where: { codigoConvite: nivel2.convidadoPorId }
                            });

                            if (nivel3) {
                                const bonusNivel3 = preco * 0.01;
                                await prisma.usuario.update({
                                    where: { id: nivel3.id },
                                    data: { saldo: { increment: bonusNivel3 } }
                                });

                                await prisma.historico.create({
                                    data: {
                                        usuarioId: nivel3.id,
                                        valor: bonusNivel3,
                                        descricao: `Bônus de indicação nível 3 (${usuario.mobile})`
                                    }
                                });
                            }
                        }
                    }
                }
            }
        }

        res.json({ code: 200, msg: "Compra efetuada com sucesso", investimento });

    } catch (error) {
        console.error(error);
        res.status(500).json({ code: 500, msg: "Erro interno", error: error.message });
    }
});

app.get("/investimentos", autenticarToken, async (req, res) => {
    try {
        const investimentos = await prisma.investimento.findMany({
            where: { 
                usuarioId: req.user.id,
                dataExpiracao: {
                    gt: new Date()
                }
            },
            orderBy: { dataCompra: 'desc' }
        });

        res.json({ 
            code: 200, 
            data: investimentos 
        });
    } catch (error) {
        console.error('Erro ao buscar investimentos:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao buscar investimentos' 
        });
    }
});

// Rotas de conta bancária
app.post('/user/save-bank-account', autenticarToken, async (req, res) => {
    try {
        const { name, bank, account } = req.body;
        const userId = req.user.id;

        if (!['BFA', 'BAI', 'BIC', 'ATL'].includes(bank)) {
            return res.status(400).json({
                code: 400,
                msg: 'Banco selecionado é inválido'
            });
        }

        if (!/^\d{21}$/.test(account)) {
            return res.status(400).json({
                code: 400,
                msg: 'Número da conta deve ter exatamente 21 dígitos'
            });
        }

        const bankAccount = await prisma.contaBancaria.upsert({
            where: { usuarioId: userId },
            update: {
                nomeTitular: name,
                banco: bank,
                numeroConta: account,
                atualizadoEm: new Date()
            },
            create: {
                usuarioId: userId,
                nomeTitular: name,
                banco: bank,
                numeroConta: account
            }
        });

        res.json({
            code: 200,
            msg: 'Conta bancária salva com sucesso',
            data: {
                id: bankAccount.id,
                banco: bank,
                ultimosDigitos: account.slice(-4)
            }
        });

    } catch (error) {
        console.error('Erro ao salvar conta bancária:', error);
        res.status(500).json({
            code: 500,
            msg: 'Erro ao salvar conta bancária'
        });
    }
});

app.get('/user/bank-account', autenticarToken, async (req, res) => {
    try {
        const conta = await prisma.contaBancaria.findUnique({
            where: { usuarioId: req.user.id }
        });

        if (!conta) {
            return res.status(404).json({ 
                code: 404, 
                msg: 'Conta bancária não cadastrada' 
            });
        }

        res.json(conta);
    } catch (error) {
        console.error('Erro ao buscar conta bancária:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao buscar conta bancária' 
        });
    }
});

// Rotas de depósito
app.post('/deposit/generate', autenticarToken, async (req, res) => {
    try {
        const { amount, bank } = req.body;
        const userId = req.user.id;

        if (!amount || amount <= 0 || !bank) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Dados inválidos' 
            });
        }

        const validBanks = ['BFA', 'BAI', 'BIC', 'ATL'];
        if (!validBanks.includes(bank)) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Banco inválido' 
            });
        }

        const adminAccount = await prisma.contaAdmin.findFirst({
            where: { banco: bank }
        });

        if (!adminAccount) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Banco não disponível para depósito' 
            });
        }

        let finalAmount = parseFloat(amount);
        let centsAvailable = true;

        for (let cents = 1; cents <= 99; cents++) {
            const testAmount = parseFloat(`${amount}.${cents.toString().padStart(2, '0')}`);
            
            const existingDeposit = await prisma.deposito.findFirst({
                where: { 
                    valorExato: testAmount,
                    banco: bank,
                    status: 'PENDENTE'
                }
            });

            if (!existingDeposit) {
                finalAmount = testAmount;
                break;
            }

            if (cents === 99) {
                centsAvailable = false;
            }
        }

        if (!centsAvailable) {
            finalAmount = amount - 1;
            finalAmount = parseFloat(finalAmount.toFixed(2));
        }

        const deposito = await prisma.deposito.create({
            data: {
                usuarioId: userId,
                valorSolicitado: amount,
                valorExato: finalAmount,
                banco: bank,
                status: 'PENDENTE',
                contaAdminId: adminAccount.id
            }
        });

        res.json({
            code: 200,
            finalAmount: finalAmount,
            bankDetails: {
                bankName: getBankName(bank),
                accountName: adminAccount.nomeTitular,
                iban: adminAccount.iban
            }
        });

    } catch (error) {
        console.error('Erro ao gerar depósito:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao gerar depósito',
            error: error.message 
        });
    }
});

// Rotas de saque
app.post('/withdraw', autenticarToken, async (req, res) => {
    try {
        const { amount, fee, netAmount, bankAccount } = req.body;
        const userId = req.user.id;
        
        const usuario = await prisma.usuario.findUnique({
            where: { id: userId },
            select: { saldo: true }
        });
        
        if (!usuario || usuario.saldo < amount) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Saldo insuficiente para esta retirada' 
            });
        }
        
        const hoje = new Date();
        const diaSemana = hoje.getDay();
        if (diaSemana === 0) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Saque disponível apenas de segunda a sábado' 
            });
        }
        
        const horas = hoje.getHours();
        if (horas < 9 || horas >= 21) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Horário de saque: 09h às 21h' 
            });
        }
        
        await prisma.usuario.update({
            where: { id: userId },
            data: { saldo: { decrement: amount } }
        });
        
        await prisma.historico.create({
            data: {
                usuarioId: userId,
                valor: -amount,
                descricao: `Saque de KZ ${netAmount.toFixed(2)} (taxa de ${fee*100}%)`,
                tipo: 'SAQUE'
            }
        });
        
        const retirada = await prisma.retirada.create({
            data: {
                usuarioId: userId,
                valorBruto: amount,
                valorLiquido: netAmount,
                taxa: fee,
                status: 'PENDENTE',
                banco: bankAccount.banco,
                conta: bankAccount.numeroConta,
                nomeTitular: bankAccount.nomeTitular
            }
        });
        
        res.json({ 
            code: 200, 
            msg: 'Saque solicitado com sucesso',
            data: retirada 
        });
        
    } catch (error) {
        console.error('Erro ao processar saque:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao processar saque',
            error: error.message 
        });
    }
});

app.get('/withdrawals', autenticarToken, async (req, res) => {
    try {
        const retiradas = await prisma.retirada.findMany({
            where: { usuarioId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });
        
        res.json({ 
            code: 200, 
            data: retiradas 
        });
    } catch (error) {
        console.error('Erro ao buscar retiradas:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao buscar histórico de retiradas' 
        });
    }
});

// Rotas de histórico
app.get("/historico", autenticarToken, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const offset = (page - 1) * limit;

        const historico = await prisma.historico.findMany({
            where: { usuarioId: req.user.id },
            orderBy: { data: "desc" },
            skip: offset,
            take: limit,
            select: {
                id: true,
                valor: true,
                descricao: true,
                tipo: true,
                data: true
            }
        });

        res.json({ 
            code: 200, 
            historico,
            pagination: {
                page,
                limit,
                total: await prisma.historico.count({ where: { usuarioId: req.user.id } }),
                totalPages: Math.ceil(await prisma.historico.count({ where: { usuarioId: req.user.id } }) / limit)
            }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ code: 500, msg: "Erro interno", error: error.message });
    }
});

// Rota para trocar senha
app.post('/user/change-password', autenticarToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const userId = req.user.id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Preencha todos os campos' 
            });
        }

        if (newPassword.length < 6 || newPassword.length > 32) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'A senha deve ter entre 6 e 32 caracteres' 
            });
        }

        const usuario = await prisma.usuario.findUnique({
            where: { id: userId },
            select: { password: true }
        });

        if (!usuario) {
            return res.status(404).json({ 
                code: 404, 
                msg: 'Usuário não encontrado' 
            });
        }

        const senhaCorreta = await bcrypt.compare(currentPassword, usuario.password);
        if (!senhaCorreta) {
            return res.status(401).json({ 
                code: 401, 
                msg: 'Senha atual incorreta' 
            });
        }

        const mesmaSenha = await bcrypt.compare(newPassword, usuario.password);
        if (mesmaSenha) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'A nova senha deve ser diferente da atual' 
            });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await prisma.usuario.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });

        res.json({ 
            code: 200, 
            msg: 'Senha alterada com sucesso' 
        });

    } catch (error) {
        console.error('Erro ao alterar senha:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao alterar senha',
            error: error.message 
        });
    }
});

// Rota para resgatar código do tesouro
app.post('/treasure/redeem', autenticarToken, async (req, res) => {
    try {
        const { code } = req.body;
        const userId = req.user.id;
        
        if (!code || code.length !== 6) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Código inválido' 
            });
        }
        
        const validCodes = [
            'A7K2QX', 'Z3M8YT', 'L9B4ND', 'P1E6WS', 'T8C5VR', 'M7Q1LP', 'H6Z8GF', 'Q5X2JN', 'Y4W9TR', 'B2V7KM',
            // ... (todos os outros códigos que você tinha)
            'G8M9QT', 'X6P1WL', 'N9K4VR', 'T2Y7MP', 'H8L3XN', 'K9M5WP', 'M1B8QT', 'V3P9LR', 'P6X4HT', 'W8Y9HN'
        ];
        
        if (!validCodes.includes(code)) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Código inválido' 
            });
        }
        
        const usedCode = await prisma.codigoTesouro.findUnique({
            where: { codigo: code }
        });
        
        if (usedCode) {
            return res.status(400).json({ 
                code: 400, 
                msg: 'Este código já foi utilizado' 
            });
        }
        
        const prizeAmount = 200;
        
        await prisma.codigoTesouro.create({
            data: {
                codigo: code,
                usuarioId: userId,
                valor: prizeAmount
            }
        });
        
        await prisma.usuario.update({
            where: { id: userId },
            data: { 
                saldo: { increment: prizeAmount } 
            }
        });
        
        await prisma.historico.create({
            data: {
                usuarioId: userId,
                valor: prizeAmount,
                descricao: `Resgate do código ${code}`,
                tipo: 'BONUS'
            }
        });
        
        res.json({ 
            code: 200, 
            msg: 'Código resgatado com sucesso',
            prize: prizeAmount 
        });
        
    } catch (error) {
        console.error('Erro ao resgatar código:', error);
        res.status(500).json({ 
            code: 500, 
            msg: 'Erro ao resgatar código',
            error: error.message 
        });
    }
});

// Rota para obter informações do usuário por código de convite
app.get("/usuario/:codigoConvite", async (req, res) => {
    try {
        const { codigoConvite } = req.params;

        const usuario = await prisma.usuario.findUnique({
            where: { codigoConvite },
            select: {
                mobile: true,
                codigoConvite: true,
                saldo: true,
                createdAt: true
            }
        });

        if (!usuario) {
            return res.status(404).json({ code: 404, msg: "Usuário não encontrado" });
        }

        res.json(usuario);

    } catch (error) {
        console.error(error);
        res.status(500).json({ code: 500, msg: "Erro interno no servidor" });
    }
});

// Rota para verificar disponibilidade do número
app.get("/check-mobile/:mobile", async (req, res) => {
    try {
        const { mobile } = req.params;

        const usuario = await prisma.usuario.findUnique({
            where: { mobile }
        });

        res.json({
            available: !usuario
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            code: 500, 
            msg: "Erro ao verificar número" 
        });
    }
});

// Rota para obter informações da equipe
app.get("/team", autenticarToken, async (req, res) => {
    try {
        const codigoConviteUsuario = req.user.codigoConvite;

        const buscarUsuarios = async (codigosConvite) => {
            return await prisma.usuario.findMany({
                where: { 
                    convidadoPorId: { in: codigosConvite } 
                },
                select: {
                    id: true,
                    mobile: true,
                    codigoConvite: true,
                    investimentos: {
                        select: {
                            preco: true,
                            nome: true
                        }
                    }
                }
            });
        };

        const nivel1 = await buscarUsuarios([codigoConviteUsuario]);
        const codigosNivel1 = nivel1.map(u => u.codigoConvite);
        const nivel2 = codigosNivel1.length > 0 ? await buscarUsuarios(codigosNivel1) : [];
        const codigosNivel2 = nivel2.map(u => u.codigoConvite);
        const nivel3 = codigosNivel2.length > 0 ? await buscarUsuarios(codigosNivel2) : [];

        const processarNivel = (usuarios) => {
            return usuarios.map(u => {
                const totalInvestido = u.investimentos.reduce((sum, inv) => sum + inv.preco, 0);
                return {
                    ...u,
                    status: totalInvestido > 0 ? 'ativo' : 'inativo',
                    totalInvestido,
                    produtos: u.investimentos.map(inv => inv.nome)
                };
            });
        };

        const calcularTotalGeral = (...niveis) => {
            return niveis.flat()
                .reduce((total, user) => total + user.totalInvestido, 0);
        };

        const response = {
            nivel1: processarNivel(nivel1),
            nivel2: processarNivel(nivel2),
            nivel3: processarNivel(nivel3),
            totalGeral: calcularTotalGeral(nivel1, nivel2, nivel3)
        };

        res.json(response);

    } catch (error) {
        console.error(error);
        res.status(500).json({ 
            code: 500, 
            msg: "Erro ao carregar equipe",
            error: error.message 
        });
    }
});

// Iniciar o cron de rendimentos
iniciarCronRendimentos();

// Iniciar o servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});