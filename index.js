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
    MIN_LP_BURN_PCT: parseFloat(process.env.MIN_LP_BURN_PCT || '0.99'),
    MIN_SOL_BURN: parseFloat(process.env.MIN_SOL_BURN || '0'),
    PORT: parseInt(process.env.PORT || '8080'),
    RATE_MS: parseInt(process.env.RATE_MS || '12000'),
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
            wsEndpoint: config.RPC_WSS
        });
        
        this.subscriptions = [];
        this.detectedBurns = new Map();
        this.poolCache = new Map();
        this.tokenCache = new Map();
        this.startTime = Date.now();
        this.burnCount = 0;
        
        logger.info('LP Burn Monitor initialized');
        logger.info(`RPC HTTP: ${config.RPC_HTTP}`);
        logger.info(`RPC WSS: ${config.RPC_WSS}`);
    }

    /**
     * Start monitoring
     */
    async start() {
        logger.info('🚀 Starting Raydium LP Burn Monitor...');
        
        try {
            // Test connection
            const version = await this.connection.getVersion();
            logger.info(`Connected to Solana - Version: ${version['solana-core']}`);
            
            // Subscribe to various monitoring methods
            await this.subscribeToRaydiumPrograms();
            await this.subscribeToTokenPrograms();
            
            // Send startup notification
            await this.sendTelegramMessage(
                '🚀 *LP Burn Monitor Started*\n' +
                `⚙️ Min LP Burn: ${(config.MIN_LP_BURN_PCT * 100).toFixed(0)}%\n` +
                `⏱️ Min Token Age: ${config.MIN_BURN_MINT_AGE_MIN} min\n` +
                `💰 Min SOL Burn: ${config.MIN_SOL_BURN} SOL\n` +
                `🔄 Rate: ${config.RATE_MS}ms`
            );
            
            logger.info('✅ All monitoring subscriptions active');
            
            // Periodic stats
            setInterval(() => this.logStats(), 60000);
            
        } catch (error) {
            logger.error(`Failed to start monitor: ${error.message}`);
            throw error;
        }
    }

    /**
     * Subscribe to Raydium programs
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
                    await this.processLogs(logs, context, program.toBase58());
                },
                'confirmed'
            );
            
            this.subscriptions.push(subId);
            logger.debug(`Subscribed to program: ${program.toBase58().slice(0, 8)}...`);
        }
    }

    /**
     * Subscribe to token programs
     */
    async subscribeToTokenPrograms() {
        const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
        
        for (const program of programs) {
            const subId = this.connection.onLogs(
                program,
                async (logs, context) => {
                    await this.processTokenLogs(logs, context);
                },
                'confirmed'
            );
            
            this.subscriptions.push(subId);
        }
        
        logger.debug('Subscribed to token programs');
    }

    /**
     * Process Raydium program logs
     */
    async processLogs(logs, context, programId) {
        const signature = logs.signature;
        
        // Check if already processed
        if (this.detectedBurns.has(signature)) return;
        
        // Look for burn patterns
        if (this.detectBurnPattern(logs.logs)) {
            logger.debug(`Potential burn detected in tx: ${signature}`);
            await this.analyzeTransaction(signature, context.slot);
        }
    }

    /**
     * Process token program logs
     */
    async processTokenLogs(logs, context) {
        const signature = logs.signature;
        
        if (this.detectedBurns.has(signature)) return;
        
        const logMessages = logs.logs || [];
        
        // Only process if Raydium is involved
        const hasRaydium = logMessages.some(msg => 
            msg.includes('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8') ||
            msg.includes('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK') ||
            msg.includes('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
        );
        
        if (!hasRaydium) return;
        
        // Check for burn instructions or transfers to burn addresses
        for (const message of logMessages) {
            if (message.includes('Instruction: Burn') ||
                message.includes('Instruction: BurnChecked') ||
                this.containsBurnAddress(message)) {
                
                logger.debug(`LP Token burn detected in tx: ${signature}`);
                await this.analyzeTransaction(signature, context.slot);
                break;
            }
        }
    }

    /**
     * Detect burn patterns in logs
     */
    detectBurnPattern(logs) {
        if (!logs) return false;
        
        for (const log of logs) {
            // Check for burn-related keywords
            if (log.toLowerCase().includes('burn') ||
                log.toLowerCase().includes('remove liquidity') ||
                this.containsBurnAddress(log)) {
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
     * Analyze transaction for LP burn
     */
    async analyzeTransaction(signature, slot) {
        try {
            // Mark as processed
            this.detectedBurns.set(signature, true);
            
            // Rate limiting
            await this.sleep(config.RATE_MS);
            
            // Fetch transaction
            const tx = await this.connection.getTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });
            
            if (!tx || !tx.meta) {
                logger.debug(`No transaction data for: ${signature}`);
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
        }
    }

    /**
     * Extract burn information from transaction
     */
    async extractBurnInfo(tx) {
        const { meta, transaction } = tx;
        
        if (!meta.postTokenBalances || !meta.preTokenBalances) {
            return null;
        }
        
        const burnInfo = {
            tokenMint: null,
            burnAmount: 0,
            burnPercentage: 0,
            burner: null,
            poolId: null,
            timestamp: tx.blockTime,
            solValue: 0,
            isLPToken: false
        };
        
        // Check if this involves Raydium
        const hasRaydiumProgram = transaction.message.accountKeys.some(key => 
            key.toBase58() === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ||
            key.toBase58() === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' ||
            key.toBase58() === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
        );
        
        // Find LP token burns
        for (let i = 0; i < meta.preTokenBalances.length; i++) {
            const pre = meta.preTokenBalances[i];
            const post = meta.postTokenBalances.find(p => 
                p.accountIndex === pre.accountIndex
            );
            
            if (!post) continue;
            
            const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
            const postAmount = BigInt(post.uiTokenAmount.amount || 0);
            
            // Check if this is a burn (transfer to burn address)
            if (BURN_ADDRESSES.includes(post.owner) && postAmount > preAmount) {
                // Tokens received at burn address
                const burnAmount = postAmount - preAmount;
                
                burnInfo.tokenMint = pre.mint;
                burnInfo.burnAmount = Number(burnAmount) / Math.pow(10, pre.uiTokenAmount.decimals);
                
                // Check if this is an LP token
                burnInfo.isLPToken = await this.isLPToken(pre.mint, tx);
                
                // Find the sender
                const sender = meta.preTokenBalances.find(b => 
                    b.mint === pre.mint && 
                    !BURN_ADDRESSES.includes(b.owner) &&
                    BigInt(b.uiTokenAmount.amount) >= burnAmount
                );
                
                if (sender) {
                    burnInfo.burner = sender.owner;
                    
                    // Calculate burn percentage
                    const senderPreAmount = BigInt(sender.uiTokenAmount.amount || 0);
                    if (senderPreAmount > 0n) {
                        burnInfo.burnPercentage = Number(burnAmount) / Number(senderPreAmount);
                    }
                }
            }
            
            // Alternative: Check for direct burns (amount decrease to 0)
            if (preAmount > 0n && postAmount === 0n && !BURN_ADDRESSES.includes(pre.owner)) {
                const burnAmount = preAmount;
                
                burnInfo.tokenMint = pre.mint;
                burnInfo.burnAmount = Number(burnAmount) / Math.pow(10, pre.uiTokenAmount.decimals);
                burnInfo.burner = pre.owner;
                burnInfo.burnPercentage = 1.0; // 100% burn
                burnInfo.isLPToken = await this.isLPToken(pre.mint, tx);
            }
        }
        
        // Only return if it's an LP token or involves Raydium
        if (!burnInfo.isLPToken && !hasRaydiumProgram) {
            return null;
        }
        
        // Try to identify pool
        burnInfo.poolId = await this.identifyPool(tx);
        
        // Estimate SOL value
        burnInfo.solValue = await this.estimateSolValue(burnInfo);
        
        return burnInfo.tokenMint ? burnInfo : null;
    }
    
    /**
     * Check if token is an LP token
     */
    async isLPToken(mintAddress, tx) {
        try {
            // Check if mint is associated with a Raydium pool
            // LP tokens usually have specific naming patterns or are created by Raydium
            
            // Method 1: Check if the transaction involves pool operations
            const hasPoolOps = tx.meta.logMessages?.some(log => 
                log.includes('pool') || 
                log.includes('liquidity') ||
                log.includes('LP') ||
                log.includes('Raydium')
            );
            
            if (hasPoolOps) return true;
            
            // Method 2: Check token mint authority
            // Raydium LP tokens often have specific authorities
            const mintInfo = await this.connection.getParsedAccountInfo(new PublicKey(mintAddress));
            if (mintInfo?.value?.data?.parsed?.info?.mintAuthority) {
                const authority = mintInfo.value.data.parsed.info.mintAuthority;
                if (authority === RAYDIUM_AUTHORITY_V4.toBase58()) {
                    return true;
                }
            }
            
            // Method 3: Check if this mint is in our LP token cache
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
     * Identify pool from transaction
     */
    async identifyPool(tx) {
        const instructions = tx.transaction.message.instructions || [];
        
        for (const ix of instructions) {
            const programId = tx.transaction.message.accountKeys[ix.programIdIndex];
            
            // Check if Raydium instruction
            if (programId && (
                programId.equals(RAYDIUM_LIQUIDITY_POOL_V4) ||
                programId.equals(RAYDIUM_AMM_PROGRAM) ||
                programId.equals(RAYDIUM_CPMM_PROGRAM)
            )) {
                // First account is usually the pool
                if (ix.accounts && ix.accounts.length > 0) {
                    return tx.transaction.message.accountKeys[ix.accounts[0]].toBase58();
                }
            }
        }
        
        return null;
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
        // Only validate LP tokens
        if (!burnInfo.isLPToken) {
            logger.debug(`Not an LP token burn: ${burnInfo.tokenMint}`);
            return false;
        }
        
        // Check burn percentage
        if (burnInfo.burnPercentage < config.MIN_LP_BURN_PCT) {
            logger.debug(`LP burn percentage too low: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
            return false;
        }
        
        // Check SOL value
        if (burnInfo.solValue < config.MIN_SOL_BURN) {
            logger.debug(`SOL value too low: ${burnInfo.solValue} SOL`);
            return false;
        }
        
        // Check token age (if we have creation time)
        if (burnInfo.timestamp) {
            const ageMinutes = (Date.now() / 1000 - burnInfo.timestamp) / 60;
            if (ageMinutes < config.MIN_BURN_MINT_AGE_MIN) {
                logger.debug(`Token too new: ${ageMinutes.toFixed(0)} minutes`);
                return false;
            }
        }
        
        return true;
    }

    /**
     * Handle valid LP burn
     */
    async handleValidBurn(signature, burnInfo, slot) {
        logger.info(`🔥 VALID LP BURN DETECTED!`);
        logger.info(`  Signature: ${signature}`);
        logger.info(`  Token: ${burnInfo.tokenMint}`);
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
        
        await this.sendTelegramMessage(message);
    }

    /**
     * Send message to Telegram
     */
    async sendTelegramMessage(message) {
        if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) {
            logger.warn('Telegram credentials not configured');
            return;
        }
        
        try {
            const url = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
            
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
                logger.error(`Telegram error: ${error}`);
            } else {
                logger.debug('Telegram notification sent');
            }
            
        } catch (error) {
            logger.error(`Failed to send Telegram message: ${error.message}`);
        }
    }

    /**
     * Log statistics
     */
    logStats() {
        const runtime = Date.now() - this.startTime;
        const hours = Math.floor(runtime / (1000 * 60 * 60));
        const minutes = Math.floor((runtime % (1000 * 60 * 60)) / (1000 * 60));
        
        logger.info(`📊 Stats - Runtime: ${hours}h ${minutes}m, Burns: ${this.burnCount}, Cache: ${this.detectedBurns.size} txs`);
        
        // Clean old cache entries
        if (this.detectedBurns.size > 10000) {
            const toDelete = this.detectedBurns.size - 5000;
            const keys = Array.from(this.detectedBurns.keys());
            for (let i = 0; i < toDelete; i++) {
                this.detectedBurns.delete(keys[i]);
            }
            logger.debug(`Cleaned ${toDelete} old cache entries`);
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
        logger.info('Stopping monitor...');
        
        for (const subId of this.subscriptions) {
            try {
                await this.connection.removeOnLogsListener(subId);
            } catch (error) {
                // Ignore
            }
        }
        
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
        
    } catch (error) {
        logger.error(`Fatal error: ${error.message}`);
        process.exit(1);
    }
}

// Start the application
main();
