import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fetch from 'node-fetch';
import express from 'express';
import winston from 'winston';
import dotenv from 'dotenv';
import bs58 from 'bs58';

// Load environment variables
dotenv.config();

// ============================================
// CONFIGURATION FROM ENV
// ============================================
const config = {
    DEBUG: process.env.DEBUG === '1',
    DEXS_ENABLED: process.env.DEXS_ENABLED === '1',
    HELIUS_API_KEY: process.env.HELIUS_API_KEY,
    MAX_TOKEN_AGE_MIN: parseInt(process.env.MAX_TOKEN_AGE_MIN || '1440'),
    MAX_VAULT_OUTFLOW: parseFloat(process.env.MAX_VAULT_OUTFLOW || '0.001'),
    MIN_BURN_MINT_AGE_MIN: parseInt(process.env.MIN_BURN_MINT_AGE_MIN || '15'),
    MIN_LP_BURN_PCT: parseFloat(process.env.MIN_LP_BURN_PCT || '0.90'),
    MIN_SOL_BURN: parseFloat(process.env.MIN_SOL_BURN || '0'),
    PORT: parseInt(process.env.PORT || '8080'),
    RATE_MS: parseInt(process.env.RATE_MS || '30000'), // 30 seconds default
    RPC_HTTP: process.env.RPC_HTTP,
    RPC_WSS: process.env.RPC_WSS,
    TG_BOT_TOKEN: process.env.TG_BOT_TOKEN,
    TG_CHAT_ID: process.env.TG_CHAT_ID
};

// ============================================
// LOGGER SETUP
// ============================================
const logger = winston.createLogger({
    level: config.DEBUG ? 'debug' : 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'lp-burns.log' })
    ]
});

// ============================================
// CONSTANTS
// ============================================
const RAYDIUM_LIQUIDITY_POOL_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_AUTHORITY_V4 = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
const RAYDIUM_AMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

// Burn addresses
const BURN_ADDRESSES = [
    '1111111111111111111111111111111111111111111',
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'AwRErBEFGTnohzfLeRSBH9HddQEy2oeRxnWLrbvFFh95',
    'BurnHTLinLbh1JQnH7TN3UCNNhTMRiJDTiTvyZvoiJJx'
];

// ============================================
// LP BURN MONITOR CLASS
// ============================================
class RaydiumLPBurnMonitor {
    constructor() {
        this.connection = new Connection(config.RPC_HTTP, {
            commitment: 'confirmed',
            wsEndpoint: config.RPC_WSS,
            confirmTransactionInitialTimeout: 60000
        });
        
        this.subscriptions = [];
        this.detectedBurns = new Map();
        this.poolCache = new Map();
        this.tokenCache = new Map();
        this.startTime = Date.now();
        this.burnCount = 0;
        this.retryCount = 0;
        this.isRunning = false;
        
        logger.info('LP Burn Monitor initialized');
        logger.info(`RPC HTTP: ${config.RPC_HTTP}`);
        logger.info(`RPC WSS: ${config.RPC_WSS}`);
    }

    /**
     * Start monitoring
     */
    async start() {
        if (this.isRunning) {
            logger.warn('Monitor already running, skipping start');
            return;
        }
        this.isRunning = true;
        this.transactionQueue = [];
        logger.info('🚀 Starting Raydium LP Burn Monitor...');
        
        try {
            const versionPromise = this.connection.getVersion();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), 10000)
            );
            const version = await Promise.race([versionPromise, timeoutPromise]);
            logger.info(`Connected to Solana - Version: ${version['solana-core']}`);
            
            await this.subscribeToRaydiumPrograms();

            if (this.burnCount === 0) {
                await this.sendTelegramMessage(
                    '🚀 *LP Burn Monitor Started*\n' +
                    `📍 *Mode:* Raydium Programs Only\n` +
                    `⚙️ Min LP Burn: ${(config.MIN_LP_BURN_PCT * 100).toFixed(0)}%\n` +
                    `⏱️ Min Token Age: ${config.MIN_BURN_MINT_AGE_MIN} min\n` +
                    `💰 Min SOL Burn: ${config.MIN_SOL_BURN} SOL\n` +
                    `🔄 Rate: ${config.RATE_MS}ms (${(config.RATE_MS/1000).toFixed(0)}s)`
                );
            }
            
            logger.info('✅ Monitoring Raydium programs only');
            logger.info(`⏱️ Rate limiting set to ${config.RATE_MS}ms between transactions`);
            
            this.startQueueProcessor();
            if (!this.statsInterval) {
                this.statsInterval = setInterval(() => this.logStats(), 60000);
            }
        } catch (error) {
            this.isRunning = false;
            logger.error(`Failed to start monitor: ${error.message}`);
            throw error;
        }
    }

    startQueueProcessor() {
        if (this.queueProcessor) {
            clearInterval(this.queueProcessor);
        }
        this.queueProcessor = setInterval(async () => {
            if (this.transactionQueue && this.transactionQueue.length > 0) {
                await this.processQueue();
            }
        }, config.RATE_MS);
        logger.info(`Queue processor started with ${config.RATE_MS}ms interval`);
    }

    async subscribeToRaydiumPrograms() {
        const programs = [
            RAYDIUM_LIQUIDITY_POOL_V4,
            RAYDIUM_AMM_PROGRAM,
            RAYDIUM_CPMM_PROGRAM
        ];
        for (const program of programs) {
            const subId = this.connection.onLogs(
                program,
                async (logs, context) => {
                    await this.processRaydiumLogs(logs, context, program.toBase58());
                },
                'confirmed'
            );
            this.subscriptions.push(subId);
            logger.info(`✅ Subscribed to Raydium program: ${program.toBase58().slice(0, 8)}...`);
        }
    }

    /**
     * Process Raydium program logs for LP burns
     */
    async processRaydiumLogs(logs, context, programId) {
        const signature = logs.signature;
        if (this.detectedBurns.has(signature)) return;
        const logMessages = logs.logs || [];

        // === HARD SKIP: if the word "remove" appears anywhere in logs ===
        const hasRemoveWord = logMessages.some(l => l && l.toLowerCase().includes('remove'));
        if (hasRemoveWord) {
            logger.debug(`Skipping tx due to 'remove' keyword in logs: ${signature.slice(0, 8)}...`);
            return;
        }

        // Skip swaps early
        const isSwap = logMessages.some(log =>
            log && (
                log.toLowerCase().includes('swap') ||
                log.toLowerCase().includes('route') ||
                log.toLowerCase().includes('jupiter') ||
                log.toLowerCase().includes('trade')
            )
        );
        if (isSwap) {
            logger.debug(`Skipping swap transaction: ${signature.slice(0, 8)}...`);
            return;
        }

        // Look for PERMANENT burn patterns only
        const hasPermanentBurn = logMessages.some(log => 
            log && (
                log.includes('Instruction: Burn') ||
                log.includes('Instruction: BurnChecked') ||
                // Transfer TO a burn address (permanent), but never if 'remove' appeared (already skipped above)
                (BURN_ADDRESSES.some(addr => log.includes(addr)) && log.includes('Transfer'))
            )
        );

        if (!hasPermanentBurn) {
            logger.debug(`No permanent burn pattern in tx: ${signature.slice(0, 8)}...`);
            return;
        }

        logger.info(`🔥 PERMANENT LP burn detected in Raydium tx: ${signature.slice(0, 8)}...`);
        this.queueTransaction(signature, context.slot);
    }

    queueTransaction(signature, slot) {
        if (!this.transactionQueue) this.transactionQueue = [];
        if (this.detectedBurns.has(signature)) return;
        const exists = this.transactionQueue.find(tx => tx.signature === signature);
        if (!exists) {
            this.transactionQueue.push({ signature, slot, timestamp: Date.now() });
            logger.info(`📥 Queued transaction: ${signature.slice(0, 8)}... (queue size: ${this.transactionQueue.length})`);
        }
    }

    async processQueue() {
        if (!this.transactionQueue || this.transactionQueue.length === 0) return;
        const tx = this.transactionQueue.shift();
        if (!tx) return;
        logger.debug(`Processing queued tx: ${tx.signature} (queue size: ${this.transactionQueue.length})`);
        await this.analyzeTransaction(tx.signature, tx.slot);
        await this.sleep(config.RATE_MS);
    }

    /**
     * Detect burn patterns in logs (kept for other call sites, but now hard-skip 'remove')
     */
    detectBurnPattern(logs) {
        if (!logs) return false;
        for (const log of logs) {
            const lower = (log || '').toLowerCase();
            if (lower.includes('remove')) return false; // <-- HARD SKIP
            if (lower.includes('swap') || lower.includes('jupiter') || lower.includes('aggregator')) return false;
            if (lower.includes('burn') || log.includes('Instruction: BurnChecked') || log.includes('Instruction: Burn')) {
                if (!lower.includes('swap')) return true;
            }
            if (this.containsBurnAddress(log)) return true;
        }
        return false;
    }

    containsBurnAddress(message) {
        for (const burnAddr of BURN_ADDRESSES) {
            if (message.includes(burnAddr)) return true;
        }
        return false;
    }

    /**
     * Heuristic detection of Remove Liquidity
     * With hard policy: any 'remove' in logs => true
     */
    isRemoveLiquidityTx(tx) {
        try {
            const logs = (tx?.meta?.logMessages || []).join(' ').toLowerCase();

            // HARD SKIP policy
            if (logs.includes('remove')) return true;

            // (The rest kept for completeness, but 'remove' catch-all already returns above)
            const ixs = tx?.transaction?.message?.instructions || [];
            let hasBurnIx = false;
            for (const ix of ixs) {
                const p = ix.parsed;
                if (p && p.type && (p.type === 'burn' || p.type === 'burnChecked')) {
                    hasBurnIx = true;
                    break;
                }
            }
            if (!hasBurnIx) return false;

            const pre = tx?.meta?.preTokenBalances || [];
            const post = tx?.meta?.postTokenBalances || [];
            const acct = new Map();
            for (const b of pre) {
                acct.set(b.accountIndex, { owner: b.owner, mint: b.mint, pre: Number(b.uiTokenAmount?.uiAmountString || 0), post: 0 });
            }
            for (const b of post) {
                const row = acct.get(b.accountIndex) || { owner: b.owner, mint: b.mint, pre: 0, post: 0 };
                row.owner = b.owner; row.mint = b.mint; row.post = Number(b.uiTokenAmount?.uiAmountString || 0);
                acct.set(b.accountIndex, row);
            }
            const inflows = [];
            for (const [, row] of acct) {
                const delta = row.post - row.pre;
                if (delta > 0) inflows.push({ owner: row.owner, mint: row.mint, delta });
            }
            const ownerToMints = new Map();
            for (const r of inflows) {
                if (!ownerToMints.has(r.owner)) ownerToMints.set(r.owner, new Set());
                ownerToMints.get(r.owner).add(r.mint);
            }
            for (const [, mints] of ownerToMints) {
                if (mints.size >= 2) return true;
            }
            return false;
        } catch (e) {
            logger.warn(`isRemoveLiquidityTx() failed: ${e.message}`);
            return false;
        }
    }

    /**
     * Analyze transaction for LP burn
     */
    async analyzeTransaction(signature, slot) {
        try {
            if (this.detectedBurns.has(signature)) return;
            this.detectedBurns.set(signature, true);

            let tx = null;
            let retries = 3;
            let retryDelay = 5000;
            while (retries > 0 && !tx) {
                try {
                    logger.debug(`Fetching transaction: ${signature.slice(0, 8)}... (attempt ${4 - retries})`);
                    tx = await this.connection.getTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    });
                    this.retryCount = 0;
                } catch (error) {
                    const errorMessage = error.message || error.toString();
                    if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
                        retryDelay = Math.min(retryDelay * 2, 60000);
                        logger.warn(`Rate limit hit! Waiting ${retryDelay}ms before retry...`);
                        await this.sleep(retryDelay);
                        retries--;
                        if (config.RATE_MS < 60000) {
                            logger.warn('Increasing RATE_MS due to rate limits');
                            config.RATE_MS = Math.min(config.RATE_MS * 1.5, 60000);
                        }
                    } else if (errorMessage.includes('timeout')) {
                        logger.warn(`Timeout fetching tx, retrying in ${retryDelay}ms...`);
                        await this.sleep(retryDelay);
                        retries--;
                    } else {
                        logger.error(`Error fetching tx: ${errorMessage}`);
                        this.detectedBurns.delete(signature);
                        return;
                    }
                }
            }
            if (!tx || !tx.meta) {
                logger.debug(`No transaction data for: ${signature}`);
                this.detectedBurns.delete(signature);
                return;
            }

            // HARD SKIP again at analyze stage
            const logsLower = (tx.meta.logMessages || []).join(' ').toLowerCase();
            if (logsLower.includes('remove')) {
                logger.debug(`[SKIP] 'remove' keyword in analyze stage: ${signature.slice(0, 8)}...`);
                this.detectedBurns.delete(signature);
                return;
            }

            if (this.isRemoveLiquidityTx(tx)) {
                logger.debug('[SKIP] Remove-liquidity pattern detected (LP burn is part of withdrawal).');
                this.detectedBurns.delete(signature);
                return;
            }

            const burnInfo = await this.extractBurnInfo(tx);
            if (burnInfo && this.validateBurn(burnInfo)) {
                this.burnCount++;
                await this.handleValidBurn(signature, burnInfo, slot);
            }
        } catch (error) {
            logger.error(`Error analyzing tx ${signature}: ${error.message}`);
            this.detectedBurns.delete(signature);
        }
    }

    /**
     * Extract burn information from transaction
     */
    async extractBurnInfo(tx) {
        try {
            if (!tx || !tx.meta) return null;
            const { meta, transaction } = tx;
            if (!meta.postTokenBalances || !meta.preTokenBalances) return null;

            // Early skip on 'remove'
            if (meta.logMessages && meta.logMessages.some(l => l && l.toLowerCase().includes('remove'))) {
                logger.debug('Skipping in extractBurnInfo due to remove keyword');
                return null;
            }

            // Skip pure swaps
            if (meta.logMessages) {
                const isSwap = meta.logMessages.some(log => 
                    log && (
                        log.toLowerCase().includes('swap') && 
                        !log.toLowerCase().includes('remove') &&
                        !log.toLowerCase().includes('burn')
                    )
                );
                if (isSwap) {
                    logger.debug('Skipping swap transaction');
                    return null;
                }
            }
            
            const burnInfo = {
                tokenMint: null,
                burnAmount: 0,
                burnPercentage: 0,
                burner: null,
                poolId: null,
                timestamp: tx.blockTime,
                solValue: 0,
                isLPToken: true // monitoring Raydium only
            };
            
            for (let i = 0; i < meta.preTokenBalances.length; i++) {
                const pre = meta.preTokenBalances[i];
                if (!pre || !pre.uiTokenAmount) continue;
                const post = meta.postTokenBalances.find(p => p && p.accountIndex === pre.accountIndex);
                if (!post || !post.uiTokenAmount) continue;
                
                const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
                const postAmount = BigInt(post.uiTokenAmount.amount || 0);
                
                let burnDetected = false;
                let burnAmount = 0n;
                
                if (post.owner && BURN_ADDRESSES.includes(post.owner) && postAmount > preAmount) {
                    burnAmount = postAmount - preAmount;
                    burnDetected = true;
                } else if (preAmount > 0n && postAmount === 0n && pre.owner && !BURN_ADDRESSES.includes(pre.owner)) {
                    burnAmount = preAmount;
                    burnDetected = true;
                    burnInfo.burner = pre.owner;
                    burnInfo.burnPercentage = 1.0;
                } else if (preAmount > 0n && postAmount < preAmount) {
                    burnAmount = preAmount - postAmount;
                    const percentage = Number(burnAmount) / Number(preAmount);
                    if (percentage > 0.9) {
                        burnDetected = true;
                        burnInfo.burnPercentage = percentage;
                    }
                }
                
                if (burnDetected && burnAmount > 0n) {
                    burnInfo.tokenMint = pre.mint;
                    burnInfo.burnAmount = Number(burnAmount) / Math.pow(10, pre.uiTokenAmount.decimals || 9);
                    if (!burnInfo.burner) {
                        const sender = meta.preTokenBalances.find(b => 
                            b && b.mint === pre.mint && 
                            b.owner && !BURN_ADDRESSES.includes(b.owner) &&
                            BigInt(b.uiTokenAmount?.amount || 0) >= burnAmount
                        );
                        if (sender && sender.owner) {
                            burnInfo.burner = sender.owner;
                            const senderPreAmount = BigInt(sender.uiTokenAmount?.amount || 0);
                            if (senderPreAmount > 0n && burnInfo.burnPercentage === 0) {
                                burnInfo.burnPercentage = Number(burnAmount) / Number(senderPreAmount);
                            }
                        }
                    }
                    break;
                }
            }
            if (!burnInfo.tokenMint) return null;
            burnInfo.poolId = await this.identifyPool(tx);
            burnInfo.solValue = await this.estimateSolValue(burnInfo);
            return burnInfo;
        } catch (error) {
            logger.error(`Error extracting burn info: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Check if token is an LP token (early skip on 'remove')
     */
    async isLPToken(mintAddress, tx) {
        try {
            if (tx?.meta?.logMessages) {
                const hasRemove = tx.meta.logMessages.some(l => l && l.toLowerCase().includes('remove'));
                if (hasRemove) {
                    logger.debug('Not an LP token - remove keyword present');
                    return false;
                }
                const isSwap = tx.meta.logMessages.some(log => 
                    log && (
                        log.toLowerCase().includes('swap') ||
                        log.toLowerCase().includes('jupiter') ||
                        log.toLowerCase().includes('aggregator')
                    )
                );
                if (isSwap) {
                    logger.debug('Not an LP token - this is a swap transaction');
                    return false;
                }
                const hasBurnChecked = tx.meta.logMessages.some(log => 
                    log && (
                        log.includes('Instruction: BurnChecked') ||
                        log.includes('Instruction: Burn')
                    )
                );
                if (hasBurnChecked) {
                    const hasRaydiumContext = tx.transaction?.message?.accountKeys?.some(key => {
                        if (!key || !key.toBase58) return false;
                        const keyStr = key.toBase58();
                        return keyStr === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ||
                               keyStr === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' ||
                               keyStr === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
                    });
                    if (hasRaydiumContext) {
                        logger.debug('LP Token identified: BurnChecked with Raydium');
                        return true;
                    }
                }
                const hasPoolOps = tx.meta.logMessages.some(log => 
                    log && !log.toLowerCase().includes('swap') && (
                        log.toLowerCase().includes('liquidity pool') ||
                        log.toLowerCase().includes('lp token')
                    )
                );
                if (hasPoolOps) {
                    logger.debug('LP Token identified: Pool operations in logs');
                    return true;
                }
            }
            if (this.tokenCache.has(mintAddress)) {
                return this.tokenCache.get(mintAddress).isLP;
            }
            return false;
        } catch (error) {
            logger.debug(`Error checking LP token status: ${error.message}`);
            return false;
        }
    }
    
    getCurrentBurnPercentage(tx) {
        try {
            if (!tx?.meta?.preTokenBalances || !tx?.meta?.postTokenBalances) return 0;
            for (const pre of tx.meta.preTokenBalances) {
                if (!pre || !pre.uiTokenAmount) continue;
                const post = tx.meta.postTokenBalances.find(p => p && p.accountIndex === pre.accountIndex);
                if (!post || !post.uiTokenAmount) continue;
                const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
                const postAmount = BigInt(post.uiTokenAmount.amount || 0);
                if (preAmount > 0n && postAmount < preAmount) {
                    const burnAmount = preAmount - postAmount;
                    return Number(burnAmount) / Number(preAmount);
                }
            }
            return 0;
        } catch {
            return 0;
        }
    }

    async identifyPool(tx) {
        try {
            if (!tx?.transaction?.message?.instructions) return null;
            const instructions = tx.transaction.message.instructions;
            for (const ix of instructions) {
                if (!ix || typeof ix.programIdIndex === 'undefined') continue;
                const accountKeys = tx.transaction.message.accountKeys;
                if (!accountKeys || !accountKeys[ix.programIdIndex]) continue;
                const programId = accountKeys[ix.programIdIndex];
                if (programId && programId.equals && (
                    programId.equals(RAYDIUM_LIQUIDITY_POOL_V4) ||
                    programId.equals(RAYDIUM_AMM_PROGRAM) ||
                    programId.equals(RAYDIUM_CPMM_PROGRAM)
                )) {
                    if (ix.accounts && ix.accounts.length > 0 && accountKeys[ix.accounts[0]]) {
                        return accountKeys[ix.accounts[0]].toBase58();
                    }
                }
            }
            return null;
        } catch (error) {
            logger.debug(`Error identifying pool: ${error.message}`);
            return null;
        }
    }

    async estimateSolValue(burnInfo) {
        // Placeholder becslés
        return burnInfo.burnAmount * 0.01;
    }

    validateBurn(burnInfo) {
        logger.info(`🔍 Validating burn: Token ${burnInfo.tokenMint?.slice(0, 8)}... Amount: ${burnInfo.burnAmount} Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}% IsLP: ${burnInfo.isLPToken}`);
        if (!burnInfo.isLPToken) {
            logger.debug(`Not an LP token burn: ${burnInfo.tokenMint}`);
            return false;
        }
        if (burnInfo.burnPercentage < config.MIN_LP_BURN_PCT) {
            logger.debug(`LP burn percentage too low: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
            return false;
        }
        if (config.MIN_SOL_BURN > 0 && burnInfo.solValue < config.MIN_SOL_BURN) {
            logger.debug(`SOL value too low: ${burnInfo.solValue} SOL`);
            return false;
        }
        logger.info(`✅ VALID LP BURN - Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
        return true;
    }

    async handleValidBurn(signature, burnInfo, slot) {
        const shortSig = signature.slice(0, 8);
        const shortMint = burnInfo.tokenMint ? burnInfo.tokenMint.slice(0, 8) : 'Unknown';
        logger.info(`🔥 VALID LP BURN DETECTED!`);
        logger.info(`  Signature: ${shortSig}...`);
        logger.info(`  Token: ${shortMint}...`);
        logger.info(`  Amount: ${burnInfo.burnAmount.toFixed(2)}`);
        logger.info(`  Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
        logger.info(`  SOL Value: ~${burnInfo.solValue.toFixed(3)} SOL`);
        await this.sendBurnAlert(signature, burnInfo);
    }

    async sendBurnAlert(signature, burnInfo) {
        logger.info(`📤 Attempting to send Telegram alert for burn: ${signature.slice(0, 8)}...`);
        const message = 
            `🔥🔥 *LP BURN DETECTED* 🔥🔥\n\n` +
            `📝 *Token:* \`${burnInfo.tokenMint.slice(0, 8)}...\`\n` +
            `💰 *Amount:* ${burnInfo.burnAmount.toFixed(2)} LP\n` +
            `📊 *Percentage:* ${(burnInfo.burnPercentage * 100).toFixed(2)}%\n` +
            `💎 *Est. SOL Value:* ${burnInfo.solValue.toFixed(3)} SOL\n` +
            `👤 *Burner:* \`${burnInfo.burner ? burnInfo.burner.slice(0, 8) + '...' : 'Unknown'}\`\n` +
            `🏊 *Pool:* \`${burnInfo.poolId ? burnInfo.poolId.slice(0, 8) + '...' : 'Unknown'}\`\n\n` +
            `🔗 [View on Solscan](https://solscan.io/tx/${signature})\n` +
            `📈 [View on DexScreener](https://dexscreener.com/solana/${burnInfo.tokenMint})\n` +
            `🦅 [View on Birdeye](https://birdeye.so/token/${burnInfo.tokenMint})`;
        const success = await this.sendTelegramMessage(message);
        if (success) {
            logger.info(`✅ Telegram alert sent successfully for ${signature.slice(0, 8)}...`);
        } else {
            logger.error(`❌ Failed to send Telegram alert for ${signature.slice(0, 8)}...`);
        }
    }

    async sendTelegramMessage(message) {
        if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) {
            logger.error('❌ Telegram credentials not configured!');
            logger.error(`TG_BOT_TOKEN: ${config.TG_BOT_TOKEN ? 'SET' : 'MISSING'}`);
            logger.error(`TG_CHAT_ID: ${config.TG_CHAT_ID ? 'SET' : 'MISSING'}`);
            return false;
        }
        try {
            const url = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
            logger.debug(`Sending to Telegram chat: ${config.TG_CHAT_ID}`);
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: config.TG_CHAT_ID,
                    text: message,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: false
                })
            });
            if (!response.ok) {
                const error = await response.text();
                logger.error(`Telegram API error: ${error}`);
                return false;
            } else {
                logger.debug('Telegram notification sent successfully');
                return true;
            }
        } catch (error) {
            logger.error(`Failed to send Telegram message: ${error.message}`);
            return false;
        }
    }

    logStats() {
        const runtime = Date.now() - this.startTime;
        const hours = Math.floor(runtime / (1000 * 60 * 60));
        const minutes = Math.floor((runtime % (1000 * 60 * 60)) / (1000 * 60));
        const queueSize = this.transactionQueue ? this.transactionQueue.length : 0;
        logger.info(`📊 Stats - Runtime: ${hours}h ${minutes}m, Burns: ${this.burnCount}, Cache: ${this.detectedBurns.size} txs, Queue: ${queueSize} pending`);
        if (this.detectedBurns.size > 10000) {
            const toDelete = this.detectedBurns.size - 5000;
            const keys = Array.from(this.detectedBurns.keys());
            for (let i = 0; i < toDelete; i++) this.detectedBurns.delete(keys[i]);
            logger.debug(`Cleaned ${toDelete} old cache entries`);
        }
        if (this.transactionQueue && this.transactionQueue.length > 0) {
            const now = Date.now();
            const oldLength = this.transactionQueue.length;
            this.transactionQueue = this.transactionQueue.filter(tx => (now - tx.timestamp) < 600000);
            if (oldLength > this.transactionQueue.length) {
                logger.debug(`Cleaned ${oldLength - this.transactionQueue.length} old queue entries`);
            }
        }
    }

    sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    async stop() {
        if (!this.isRunning) {
            logger.info('Monitor not running');
            return;
        }
        logger.info('Stopping monitor...');
        this.isRunning = false;
        if (this.statsInterval) { clearInterval(this.statsInterval); this.statsInterval = null; }
        if (this.queueProcessor) { clearInterval(this.queueProcessor); this.queueProcessor = null; }
        for (const subId of this.subscriptions) {
            try { await this.connection.removeOnLogsListener(subId); } catch {}
        }
        this.subscriptions = [];
        this.transactionQueue = [];
        await this.sendTelegramMessage(
            `🛑 *LP Burn Monitor Stopped*\n` +
            `📊 Total burns detected: ${this.burnCount}`
        );
        logger.info('Monitor stopped');
    }
}

// ============================================
// EXPRESS SERVER (for health checks)
// ============================================
const app = express();

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/stats', (req, res) => {
    res.json({
        burns: monitor ? monitor.burnCount : 0,
        cache_size: monitor ? monitor.detectedBurns.size : 0,
        uptime: process.uptime()
    });
});

// ============================================
// MAIN EXECUTION
// ============================================
let monitor = null;

async function main() {
    try {
        app.listen(config.PORT, () => {
            logger.info(`Health check server running on port ${config.PORT}`);
        });
        monitor = new RaydiumLPBurnMonitor();
        await monitor.start();
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            if (monitor) { await monitor.stop(); }
            process.exit(0);
        });
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            if (monitor) { await monitor.stop(); }
            process.exit(0);
        });
        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught Exception: ${error.message}`);
            logger.error(error.stack);
        });
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
        });
    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        setTimeout(() => {
            logger.info('Attempting to restart after error...');
            main();
        }, 30000);
    }
}

main();
