import { Connection, PublicKey } from '@solana/web3.js';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Configuration
const config = {
    RPC_HTTP: process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com',
    MIN_LP_BURN_PCT: parseFloat(process.env.MIN_LP_BURN_PCT || '0.99'),
    MIN_SOL_BURN: parseFloat(process.env.MIN_SOL_BURN || '0')
};

// Constants
const RAYDIUM_LIQUIDITY_POOL_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_AMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

const BURN_ADDRESSES = [
    '1111111111111111111111111111111111111111111',
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'AwRErBEFGTnohzfLeRSBH9HddQEy2oeRxnWLrbvFFh95',
    'BurnHTLinLbh1JQnH7TN3UCNNhTMRiJDTiTvyZvoiJJx'
];

/**
 * Test a specific transaction for LP burn
 */
async function testTransaction(signature) {
    console.log('🔍 Testing Transaction:', signature);
    console.log('================================================\n');
    
    const connection = new Connection(config.RPC_HTTP, 'confirmed');
    
    try {
        // Fetch transaction
        console.log('📡 Fetching transaction data...');
        const tx = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
        });
        
        if (!tx) {
            console.log('❌ Transaction not found');
            return;
        }
        
        console.log('✅ Transaction found\n');
        
        // Check for Raydium programs
        console.log('🔎 Checking for Raydium programs...');
        let hasRaydium = false;
        
        if (tx.transaction?.message?.accountKeys) {
            const raydiumPrograms = [];
            
            tx.transaction.message.accountKeys.forEach(key => {
                const keyStr = key.toBase58();
                if (keyStr === RAYDIUM_LIQUIDITY_POOL_V4.toBase58()) {
                    raydiumPrograms.push('Raydium V4');
                    hasRaydium = true;
                } else if (keyStr === RAYDIUM_AMM_PROGRAM.toBase58()) {
                    raydiumPrograms.push('Raydium AMM');
                    hasRaydium = true;
                } else if (keyStr === RAYDIUM_CPMM_PROGRAM.toBase58()) {
                    raydiumPrograms.push('Raydium CPMM');
                    hasRaydium = true;
                }
            });
            
            if (hasRaydium) {
                console.log(`✅ Raydium programs found: ${raydiumPrograms.join(', ')}`);
            } else {
                console.log('❌ No Raydium programs found');
            }
        }
        
        // Check logs for burn patterns
        console.log('\n🔎 Checking logs for burn patterns...');
        const logs = tx.meta?.logMessages || [];
        let hasBurnPattern = false;
        
        for (const log of logs) {
            if (log.toLowerCase().includes('burn') ||
                log.toLowerCase().includes('remove liquidity')) {
                console.log(`✅ Burn pattern found: "${log.substring(0, 100)}..."`);
                hasBurnPattern = true;
                break;
            }
            
            // Check for burn addresses in logs
            for (const burnAddr of BURN_ADDRESSES) {
                if (log.includes(burnAddr)) {
                    console.log(`✅ Burn address found in logs: ${burnAddr.slice(0, 8)}...`);
                    hasBurnPattern = true;
                    break;
                }
            }
        }
        
        if (!hasBurnPattern) {
            console.log('⚠️ No burn patterns found in logs');
        }
        
        // Analyze token transfers
        console.log('\n🔎 Analyzing token transfers...');
        const burnInfo = await analyzeBurn(tx);
        
        if (burnInfo) {
            console.log('\n🔥 BURN DETECTED! 🔥');
            console.log('================================');
            console.log(`Token Mint: ${burnInfo.tokenMint}`);
            console.log(`Burn Amount: ${burnInfo.burnAmount.toFixed(6)}`);
            console.log(`Burn Percentage: ${(burnInfo.burnPercentage * 100).toFixed(2)}%`);
            console.log(`Burner: ${burnInfo.burner || 'Unknown'}`);
            console.log(`Is LP Token: ${burnInfo.isLPToken ? 'Yes' : 'No'}`);
            console.log('================================');
            
            // Check if it meets criteria
            console.log('\n📋 Validation:');
            
            if (burnInfo.burnPercentage >= config.MIN_LP_BURN_PCT) {
                console.log(`✅ Burn percentage (${(burnInfo.burnPercentage * 100).toFixed(2)}%) meets minimum (${(config.MIN_LP_BURN_PCT * 100).toFixed(0)}%)`);
            } else {
                console.log(`❌ Burn percentage (${(burnInfo.burnPercentage * 100).toFixed(2)}%) below minimum (${(config.MIN_LP_BURN_PCT * 100).toFixed(0)}%)`);
            }
            
            if (burnInfo.isLPToken) {
                console.log('✅ Confirmed as LP token');
            } else {
                console.log('⚠️ Not confirmed as LP token');
            }
            
            console.log('\n🎯 RESULT: This transaction would be', 
                burnInfo.isLPToken && burnInfo.burnPercentage >= config.MIN_LP_BURN_PCT ? 
                '✅ DETECTED' : '❌ IGNORED',
                'by the monitor');
            
        } else {
            console.log('\n❌ No burn found in transaction');
        }
        
    } catch (error) {
        console.error('Error testing transaction:', error.message);
    }
}

/**
 * Analyze burn in transaction
 */
async function analyzeBurn(tx) {
    if (!tx?.meta?.preTokenBalances || !tx?.meta?.postTokenBalances) {
        return null;
    }
    
    const burnInfo = {
        tokenMint: null,
        burnAmount: 0,
        burnPercentage: 0,
        burner: null,
        isLPToken: false
    };
    
    // Enhanced LP token detection
    let hasPoolOps = false;
    let hasBurnChecked = false;
    let hasRaydiumProgram = false;
    
    // Check logs
    if (tx.meta.logMessages) {
        hasPoolOps = tx.meta.logMessages.some(log => 
            log && (
                log.toLowerCase().includes('pool') || 
                log.toLowerCase().includes('liquidity') ||
                log.toLowerCase().includes('lp') ||
                log.toLowerCase().includes('raydium') ||
                log.toLowerCase().includes('amm')
            )
        );
        
        hasBurnChecked = tx.meta.logMessages.some(log => 
            log && log.includes('Instruction: BurnChecked')
        );
    }
    
    // Check for Raydium programs
    if (tx.transaction?.message?.accountKeys) {
        hasRaydiumProgram = tx.transaction.message.accountKeys.some(key => {
            const keyStr = key.toBase58();
            return keyStr === '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' ||
                   keyStr === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK' ||
                   keyStr === 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' ||
                   keyStr === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';
        });
    }
    
    // Find burns
    for (let i = 0; i < tx.meta.preTokenBalances.length; i++) {
        const pre = tx.meta.preTokenBalances[i];
        if (!pre || !pre.uiTokenAmount) continue;
        
        const post = tx.meta.postTokenBalances.find(p => 
            p && p.accountIndex === pre.accountIndex
        );
        
        if (!post || !post.uiTokenAmount) continue;
        
        const preAmount = BigInt(pre.uiTokenAmount.amount || 0);
        const postAmount = BigInt(post.uiTokenAmount.amount || 0);
        
        // Check for burn to null address
        if (post.owner && BURN_ADDRESSES.includes(post.owner) && postAmount > preAmount) {
            const burnAmount = postAmount - preAmount;
            
            burnInfo.tokenMint = pre.mint;
            burnInfo.burnAmount = Number(burnAmount) / Math.pow(10, pre.uiTokenAmount.decimals || 9);
            
            // Enhanced LP token detection
            burnInfo.isLPToken = hasPoolOps || 
                                (hasBurnChecked && hasRaydiumProgram) ||
                                (burnInfo.burnPercentage > 0.9 && hasRaydiumProgram);
            
            // Find sender
            const sender = tx.meta.preTokenBalances.find(b => 
                b && b.mint === pre.mint && 
                b.owner && !BURN_ADDRESSES.includes(b.owner) &&
                BigInt(b.uiTokenAmount?.amount || 0) >= burnAmount
            );
            
            if (sender && sender.owner) {
                burnInfo.burner = sender.owner;
                const senderPreAmount = BigInt(sender.uiTokenAmount?.amount || 0);
                if (senderPreAmount > 0n) {
                    burnInfo.burnPercentage = Number(burnAmount) / Number(senderPreAmount);
                }
            }
            
            // Re-check LP status with burn percentage
            if (burnInfo.burnPercentage > 0.9) {
                burnInfo.isLPToken = true;
            }
            
            return burnInfo;
        }
        
        // Check for direct burn (balance to 0)
        if (preAmount > 0n && postAmount === 0n && pre.owner && !BURN_ADDRESSES.includes(pre.owner)) {
            burnInfo.tokenMint = pre.mint;
            burnInfo.burnAmount = Number(preAmount) / Math.pow(10, pre.uiTokenAmount.decimals || 9);
            burnInfo.burner = pre.owner;
            burnInfo.burnPercentage = 1.0;
            
            // Enhanced LP token detection for 100% burns
            burnInfo.isLPToken = hasPoolOps || 
                                (hasBurnChecked && hasRaydiumProgram) ||
                                hasRaydiumProgram; // 100% burns with Raydium are likely LP
            
            return burnInfo;
        }
    }
    
    return null;
}

// ============================================
// MAIN EXECUTION
// ============================================

// Get transaction signature from command line
const signature = process.argv[2];

if (!signature) {
    console.log('❌ Please provide a transaction signature');
    console.log('Usage: node test-burn.js <transaction_signature>');
    console.log('Example: node test-burn.js 44teih6ktNDrj9CheUZQp4ZrinUA8b9NBg9YCFEeudh3AXYyXVn7pHxhmSPTeLArFddhfnaYWa6fStmLXPJLGznk');
    process.exit(1);
}

// Test the transaction
testTransaction(signature).then(() => {
    process.exit(0);
}).catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
