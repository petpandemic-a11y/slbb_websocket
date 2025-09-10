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
        // Prevent multiple starts
        if (this.isRunning) {
            logger.warn('Monitor already running, skipping start');
            return;
        }
        
        this.isRunning = true;
        this.transactionQueue = [];
        logger.info('🚀 Starting Raydium LP Burn Monitor...');
        
        try {
            // Test connection with timeout
            const versionPromise = this.connection.getVersion();
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), 10000)
            );
            
            const version = await Promise.race([versionPromise, timeoutPromise]);
            logger.info(`Connected to Solana - Version: ${version['solana-core']}`);
            
            // ONLY subscribe to Raydium programs - not token programs
            await this.subscribeToRaydiumPrograms();
            // NOT calling subscribeToTokenPrograms anymore
            
            // Send startup notification (only once)
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
            
            // Start queue processor
            this.startQueueProcessor();
            
            // Periodic stats (only if not already set)
            if (!this.statsInterval) {
                this.statsInterval = setInterval(() => this.logStats(), 60000);
            }
            
        } catch (error) {
            this.isRunning = false;
            logger.error(`Failed to start monitor: ${error.message}`);
            throw error;
        }
    }

    /**
     * Start the queue processor
     */
    startQueueProcessor() {
        if (this.queueProcessor) {
            clearInterval(this.queueProcessor);
        }
        
        // Process queue at regular intervals
        this.queueProcessor = setInterval(async () => {
            if (this.transactionQueue && this.transactionQueue.length > 0) {
                await this.processQueue();
            }
        }, config.RATE_MS);
        
        logger.info(`Queue processor started with ${config.RATE_MS}ms interval`);
    }

    /**
     * Subscribe to Raydium programs ONLY
     */
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
        
        // Check if already processed or queued
        if (this.detectedBurns.has(signature)) return;
        
        const logMessages = logs.logs || [];
        
        // CRITICAL: Skip swap transactions immediately
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
        
        // IMPORTANT: Skip RemoveLiquidity - we only want permanent burns
        const isRemoveLiquidity = logMessages.some(log =>
            log && (
                log.toLowerCase().includes('remove liquidity') ||
                log.toLowerCase().includes('removeliquidity') ||
                log.toLowerCase().includes('withdraw liquidity') ||
                log.toLowerCase().includes('decrease liquidity') ||
                log.toLowerCase().includes('close position') ||
                log.toLowerCase().includes('concentrated liquidity') ||
                log.toLowerCase().includes('clmm')
            )
        );
        
        if (isRemoveLiquidity) {
            logger.debug(`Skipping RemoveLiquidity - not a permanent burn: ${signature.slice(0, 8)}...`);
            return;
        }
        
        // Look for PERMANENT burn patterns only
        const hasPermanentBurn = logMessages.some(log => 
            log && (
                log.includes('Instruction: Burn') ||
                log.includes('Instruction: BurnChecked') ||
                // Transfer TO a burn address (permanent)
                (BURN_ADDRESSES.some(addr => log.includes(addr)) && 
                 log.includes('Transfer') &&
                 !log.toLowerCase().includes('remove'))
            )
        );
        
        // Skip if no permanent burn pattern
        if (!hasPermanentBurn) {
            logger.debug(`No permanent burn pattern in tx: ${signature.slice(0, 8)}...`);
            return;
        }
        
        // This looks like a PERMANENT LP burn!
        logger.info(`🔥 PERMANENT LP burn detected in Raydium tx: ${signature.slice(0, 8)}...`);
        
        // Queue for processing
        this.queueTransaction(signature, context.slot);
    }

    /**
     * Queue transaction for processing
     */
    queueTransaction(signature, slot) {
        if (!this.transactionQueue) {
            this.transactionQueue = [];
        }
        
        // Check if already processed or in queue
        if (this.detectedBurns.has(signature)) {
            return;
        }
        
        // Add to queue if not already there
        const exists = this.transactionQueue.find(tx => tx.signature === signature);
        if (!exists) {
            this.transactionQueue.push({ signature, slot, timestamp: Date.now() });
            logger.info(`📥 Queued transaction: ${signature.slice(0, 8)}... (queue size: ${this.transactionQueue.length})`);
        }
    }

    /**
     * Process queued transactions with proper rate limiting
     */
    async processQueue() {
        if (!this.transactionQueue || this.transactionQueue.length === 0) {
            return;
        }
        
        // Get next transaction from queue
        const tx = this.transactionQueue.shift();
        
        if (!tx) return;
        
        logger.debug(`Processing queued tx: ${tx.signature} (queue size: ${this.transactionQueue.length})`);
        
        // Process the transaction
        await this.analyzeTransaction(tx.signature, tx.slot);
        
        // Wait for the configured rate limit
        await this.sleep(config.RATE_MS);
    }

    /**
     * Detect burn patterns in logs
     */
    detectBurnPattern(logs) {
        if (!logs) return false;
        
        for (const log of logs) {
            // SKIP swap transactions completely
            if (log.toLowerCase().includes('swap') || 
                log.toLowerCase().includes('jupiter') ||
                log.toLowerCase().includes('aggregator')) {
                return false; // This is a swap, not a burn
            }
            
            // Check for real burn patterns
            if (log.toLowerCase().includes('burn') ||
                log.toLowerCase().includes('remove liquidity') ||
                log.includes('Instruction: BurnChecked') ||
                log.includes('Instruction: Burn')) {
                // Additional check: make sure it's not just a swap with burn in the name
                if (!log.toLowerCase().includes('swap')) {
                    return true;
                }
            }
            
            // Check for burn addresses
            if (this.containsBurnAddress(log)) {
                return true;
            }
        }
        
        return false;
    }

    /**
     * Check if message contains burn address
     */
    containsBurnAddress(message) {
        for (const burnAddr of BURN_ADDRESSES) {
            if (message.includes(burnAddr)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Heuristic detection of Remove Liquidity (CPMM/AMM) transactions
     * Returns true if the tx looks like a remove-liquidity (LP burn + base+quote payout to user),
     * so we should NOT alert this as a permanent LP burn.
     */
    isRemoveLiquidityTx(tx) {
        try {
            const logs = (tx?.meta?.logMessages || []).join(' ').toLowerCase();

            // 1) Must contain a Burn/BurnChecked on some token (likely LP mint)
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

            // 2) Detect two different mint inflows (base + quote) to the same owner
            const pre = tx?.meta?.preTokenBalances || [];
            const post = tx?.meta?.postTokenBalances || [];

            const acct = new Map(); // accountIndex -> {owner, mint, pre, post}
            for (const b of pre) {
                acct.set(b.accountIndex, {
                    owner: b.owner,
                    mint: b.mint,
                    pre: Number(b.uiTokenAmount?.uiAmountString || 0),
                    post: 0
                });
            }
            for (const b of post) {
                const row = acct.get(b.accountIndex) || { owner: b.owner, mint: b.mint, pre: 0, post: 0 };
                row.owner = b.owner;
                row.mint = b.mint;
                row.post = Number(b.uiTokenAmount?.uiAmountString || 0);
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
            let hasTwoMintsToSameOwner = false;
            for (const [, mints] of ownerToMints) {
                if (mints.size >= 2) { hasTwoMintsToSameOwner = true; break; }
            }
            if (!hasTwoMintsToSameOwner) return false;

            // 3) Raydium/CPMM remove-liquidity hints in logs
            const removeHints = [
            'remove liquidity',
            'removeliquidity',
            'withdraw liquidity',
            'decrease liquidity',
            'close position',
            'concentrated liquidity',
            'clmm',
            'cpmm',
            'raydium'
        ];
            const hasRemoveHints = removeHints.some(k => logs.includes(k));

            return hasRemoveHints;
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
            // Check if already processed
            if (this.detectedBurns.has(signature)) {
                return;
            }
            
            // Mark as processing
            this.detectedBurns.set(signature, true);
            
            // NO additional delay here - the queue processor handles all timing
            
            // Fetch transaction with retry logic and exponential backoff
            let tx = null;
            let retries = 3;
            let retryDelay = 5000; // Start with 5 seconds
            
            while (retries > 0 && !tx) {
                try {
                    logger.debug(`Fetching transaction: ${signature.slice(0, 8)}... (attempt ${4 - retries})`);
                    
                    tx = await this.connection.getTransaction(signature, {
                        maxSupportedTransactionVersion: 0,
                        commitment: 'confirmed'
                    });
                    
                    // Success - reset retry count
                    this.retryCount = 0;
                    
                } catch (error) {
                    const errorMessage = error.message || error.toString();
                    
                    if (errorMessage.includes('429') || errorMessage.includes('Too Many Requests')) {
                        retryDelay = Math.min(retryDelay * 2, 60000); // Double delay, max 60 seconds
                        logger.warn(`Rate limit hit! Waiting ${retryDelay}ms before retry...`);
                        await this.sleep(retryDelay);
                        retries--;
                        
                        // If we're getting rate limited, slow down the queue processor
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
                        // Remove from processed to retry later
                        this.detectedBurns.delete(signature);
                        return;
                    }
                }
            }
            
            if (!tx || !tx.meta) {
                logger.debug(`No transaction data for: ${signature}`);
                // Remove from processed to retry later
                this.detectedBurns.delete(signature);
                return;
            }
            
            
            // Extra guard: skip classic remove-liquidity flows (LP burn + base/quote payout)
            if (this.isRemoveLiquidityTx(tx)) {
                logger.debug('[SKIP] Remove-liquidity pattern detected (LP burn is part of withdrawal).');
                // mark as processed false so we don't keep it
                this.detectedBurns.delete(signature);
                return;
            }
            // Analyze for LP burn
            const burnInfo = await this.extractBurnInfo(tx);
            
            if (burnInfo && this.validateBurn(burnInfo)) {
                this.burnCount++;
                await this.handleValidBurn(signature, burnInfo, slot);
            }
            
        } catch (error) {
            logger.error(`Error analyzing tx ${signature}: ${error.message}`);
            // Remove from processed to retry later
            this.detectedBurns.delete(signature);
        }
    }

    /**
     * Extract burn information from transaction
     */
    async extractBurnInfo(tx) {
        try {
            if (!tx || !tx.meta) {
                return null;
            }
            
            const { meta, transaction } = tx;
            
            if (!meta.postTokenBalances || !meta.preTokenBalances) {
                return null;
            }
            
            // Since we're only monitoring Raydium programs, we know this is Raydium-related
            // But still skip pure swaps
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
                isLPToken: true // Since we're only monitoring Raydium, assume it's LP
            };
            
            // Find token burns
            for (let i = 0; i < meta.preTokenBalances.length; i++) {
                const pre = meta.preTokenBalances[i];
                if (!pre || !pre.uiTokenAmount) continue;
                
                const post = meta.postTokenBalances.find(p => 
                    p && p.accountIndex === pre.accountIndex
                );
                
                if (!post || !post.uiTokenAmount) continue;
                
                const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
                const postAmount = BigInt(post.uiTokenAmount.amount || 0);
                
                let burnDetected = false;
                let burnAmount = 0n;
                
                // Check for burn to null address
                if (post.owner && BURN_ADDRESSES.includes(post.owner) && postAmount > preAmount) {
                    burnAmount = postAmount - preAmount;
                    burnDetected = true;
                }
                // Check for direct burn (balance to 0)
                else if (preAmount > 0n && postAmount === 0n && pre.owner && !BURN_ADDRESSES.includes(pre.owner)) {
                    burnAmount = preAmount;
                    burnDetected = true;
                    burnInfo.burner = pre.owner;
                    burnInfo.burnPercentage = 1.0;
                }
                // Check for significant reduction (>90%)
                else if (preAmount > 0n && postAmount < preAmount) {
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
                    
                    // If no burner found yet, find sender
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
                    
                    // Found a burn, return it
                    break;
                }
            }
            
            if (!burnInfo.tokenMint) {
                return null;
            }
            
            // Try to identify pool
            burnInfo.poolId = await this.identifyPool(tx);
            
            // Estimate SOL value
            burnInfo.solValue = await this.estimateSolValue(burnInfo);
            
            return burnInfo;
            
        } catch (error) {
            logger.error(`Error extracting burn info: ${error.message}`);
            return null;
        }
    }
    
    /**
     * Check if token is an LP token
     */
    async isLPToken(mintAddress, tx) {
        try {
            // CRITICAL: Skip if this is a swap transaction
            if (tx?.meta?.logMessages) {
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
                
                // Check for BurnChecked - strongest indicator of LP burn
                const hasBurnChecked = tx.meta.logMessages.some(log => 
                    log && (
                        log.includes('Instruction: BurnChecked') ||
                        log.includes('Instruction: Burn')
                    )
                );
                
                if (hasBurnChecked) {
                    // Additional check: must have Raydium context
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
                
                // Check for pool/liquidity operations (but not swaps)
                const hasPoolOps = tx.meta.logMessages.some(log => 
                    log && !log.toLowerCase().includes('swap') && (
                        log.toLowerCase().includes('remove liquidity') ||
                        log.toLowerCase().includes('removeliquidity') ||
                        log.toLowerCase().includes('lp token') ||
                        log.toLowerCase().includes('liquidity pool')
                    )
                );
                
                if (hasPoolOps) {
                    logger.debug('LP Token identified: Pool operations in logs');
                    return true;
                }
            }
            
            // Check cache
            if (this.tokenCache.has(mintAddress)) {
                return this.tokenCache.get(mintAddress).isLP;
            }
            
            return false;
        } catch (error) {
            logger.debug(`Error checking LP token status: ${error.message}`);
            return false;
        }
    }
    
    /**
     * Helper to get current burn percentage from transaction
     */
    getCurrentBurnPercentage(tx) {
        try {
            if (!tx?.meta?.preTokenBalances || !tx?.meta?.postTokenBalances) {
                return 0;
            }
            
            for (const pre of tx.meta.preTokenBalances) {
                if (!pre || !pre.uiTokenAmount) continue;
                
                const post = tx.meta.postTokenBalances.find(p => 
                    p && p.accountIndex === pre.accountIndex
                );
                
                if (!post || !post.uiTokenAmount) continue;
                
                const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
                const postAmount = BigInt(post.uiTokenAmount.amount || 0);
                
                // Check for significant burn
                if (preAmount > 0n && postAmount < preAmount) {
                    const burnAmount = preAmount - postAmount;
                    return Number(burnAmount) / Number(preAmount);
                }
            }
            
            return 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Identify pool from transaction
     */
    async identifyPool(tx) {
        try {
            if (!tx?.transaction?.message?.instructions) {
                return null;
            }
            
            const instructions = tx.transaction.message.instructions;
            
            for (const ix of instructions) {
                if (!ix || typeof ix.programIdIndex === 'undefined') continue;
                
                const accountKeys = tx.transaction.message.accountKeys;
                if (!accountKeys || !accountKeys[ix.programIdIndex]) continue;
                
                const programId = accountKeys[ix.programIdIndex];
                
                // Check if Raydium instruction
                if (programId && programId.equals && (
                    programId.equals(RAYDIUM_LIQUIDITY_POOL_V4) ||
                    programId.equals(RAYDIUM_AMM_PROGRAM) ||
                    programId.equals(RAYDIUM_CPMM_PROGRAM)
                )) {
                    // First account is usually the pool
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

    /**
     * Estimate SOL value of burn
     */
    async estimateSolValue(burnInfo) {
        // This is a simplified estimation
        // In production, you'd want to fetch actual pool reserves
        return burnInfo.burnAmount * 0.01; // Placeholder
    }

    /**
     * Validate burn against criteria
     */
    validateBurn(burnInfo) {
        // Log every burn for debugging
        logger.info(`🔍 Validating burn: Token ${burnInfo.tokenMint?.slice(0, 8)}... Amount: ${burnInfo.burnAmount} Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}% IsLP: ${burnInfo.isLPToken}`);
        
        // Must be an LP token
        if (!burnInfo.isLPToken) {
            logger.debug(`Not an LP token burn: ${burnInfo.tokenMint}`);
            return false;
        }
        
        // Check burn percentage
        if (burnInfo.burnPercentage < config.MIN_LP_BURN_PCT) {
            logger.debug(`LP burn percentage too low: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
            return false;
        }
        
        // Check SOL value (optional)
        if (config.MIN_SOL_BURN > 0 && burnInfo.solValue < config.MIN_SOL_BURN) {
            logger.debug(`SOL value too low: ${burnInfo.solValue} SOL`);
            return false;
        }
        
        logger.info(`✅ VALID LP BURN - Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
        return true;
    }

    /**
     * Handle valid LP burn
     */
    async handleValidBurn(signature, burnInfo, slot) {
        const shortSig = signature.slice(0, 8);
        const shortMint = burnInfo.tokenMint ? burnInfo.tokenMint.slice(0, 8) : 'Unknown';
        
        logger.info(`🔥 VALID LP BURN DETECTED!`);
        logger.info(`  Signature: ${shortSig}...`);
        logger.info(`  Token: ${shortMint}...`);
        logger.info(`  Amount: ${burnInfo.burnAmount.toFixed(2)}`);
        logger.info(`  Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
        logger.info(`  SOL Value: ~${burnInfo.solValue.toFixed(3)} SOL`);
        
        // Send Telegram notification
        await this.sendBurnAlert(signature, burnInfo);
    }

    /**
     * Send burn alert to Telegram
     */
    async sendBurnAlert(signature, burnInfo) {
        // Always log what we're trying to send
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

    /**
     * Send message to Telegram
     */
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

    /**
     * Log statistics
     */
    logStats() {
        const runtime = Date.now() - this.startTime;
        const hours = Math.floor(runtime / (1000 * 60 * 60));
        const minutes = Math.floor((runtime % (1000 * 60 * 60)) / (1000 * 60));
        
        const queueSize = this.transactionQueue ? this.transactionQueue.length : 0;
        
        logger.info(`📊 Stats - Runtime: ${hours}h ${minutes}m, Burns: ${this.burnCount}, Cache: ${this.detectedBurns.size} txs, Queue: ${queueSize} pending`);
        
        // Clean old cache entries
        if (this.detectedBurns.size > 10000) {
            const toDelete = this.detectedBurns.size - 5000;
            const keys = Array.from(this.detectedBurns.keys());
            for (let i = 0; i < toDelete; i++) {
                this.detectedBurns.delete(keys[i]);
            }
            logger.debug(`Cleaned ${toDelete} old cache entries`);
        }
        
        // Clean old queue entries (older than 10 minutes)
        if (this.transactionQueue && this.transactionQueue.length > 0) {
            const now = Date.now();
            const oldLength = this.transactionQueue.length;
            this.transactionQueue = this.transactionQueue.filter(tx => 
                (now - tx.timestamp) < 600000 // 10 minutes
            );
            if (oldLength > this.transactionQueue.length) {
                logger.debug(`Cleaned ${oldLength - this.transactionQueue.length} old queue entries`);
            }
        }
    }

    /**
     * Sleep helper
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Stop monitoring
     */
    async stop() {
        if (!this.isRunning) {
            logger.info('Monitor not running');
            return;
        }
        
        logger.info('Stopping monitor...');
        this.isRunning = false;
        
        // Clear intervals
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        
        if (this.queueProcessor) {
            clearInterval(this.queueProcessor);
            this.queueProcessor = null;
        }
        
        // Remove subscriptions
        for (const subId of this.subscriptions) {
            try {
                await this.connection.removeOnLogsListener(subId);
            } catch (error) {
                // Ignore
            }
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
        // Start Express server
        app.listen(config.PORT, () => {
            logger.info(`Health check server running on port ${config.PORT}`);
        });
        
        // Initialize and start monitor
        monitor = new RaydiumLPBurnMonitor();
        await monitor.start();
        
        // Handle shutdown
        process.on('SIGINT', async () => {
            logger.info('Received SIGINT, shutting down gracefully...');
            if (monitor) {
                await monitor.stop();
            }
            process.exit(0);
        });
        
        process.on('SIGTERM', async () => {
            logger.info('Received SIGTERM, shutting down gracefully...');
            if (monitor) {
                await monitor.stop();
            }
            process.exit(0);
        });
        
        // Handle uncaught errors to prevent crashes
        process.on('uncaughtException', (error) => {
            logger.error(`Uncaught Exception: ${error.message}`);
            logger.error(error.stack);
            // Don't exit, try to recover
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
            // Don't exit, try to recover
        });
        
    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        
        // Try to restart after delay
        setTimeout(() => {
            logger.info('Attempting to restart after error...');
            main();
        }, 30000); // Wait 30 seconds before restart
    }
}

// Start the application
main();
