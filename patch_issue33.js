import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const indexHtmlPath = path.join(process.cwd(), 'static', 'index.html');
if (fs.existsSync(indexHtmlPath)) {
    let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

    if (!indexHtml.includes('id="credit-balance"')) {
        if (indexHtml.includes('<div class="header-actions">')) {
            indexHtml = indexHtml.replace(
                /<div class="header-actions">/i,
                `<div class="header-actions">\n        <div class="credit-display" id="credit-display" title="Remaining Credits">\n            <span class="credit-icon">🪙</span>\n            <span id="credit-balance">...</span>\n        </div>`
            );
        } else if (indexHtml.includes('</header>')) {
            indexHtml = indexHtml.replace(
                /<\/header>/i,
                `  <div class="credit-display" id="credit-display" title="Remaining Credits"><span class="credit-icon">🪙</span><span id="credit-balance">...</span></div>\n</header>`
            );
        } else if (indexHtml.includes('<nav>')) {
            indexHtml = indexHtml.replace(
                /<nav>/i,
                `<nav>\n  <div class="credit-display" id="credit-display" title="Remaining Credits"><span class="credit-icon">🪙</span><span id="credit-balance">...</span></div>`
            );
        } else {
            indexHtml = indexHtml.replace(
                /<body>/i,
                `<body>\n  <div class="credit-display" id="credit-display" title="Remaining Credits" style="position:absolute; top:10px; right:10px; z-index:1000;"><span class="credit-icon">🪙</span><span id="credit-balance">...</span></div>`
            );
        }
    }

    if (!indexHtml.includes('id="paywall-modal"')) {
        const paywallHtml = `
    <div id="paywall-modal" class="modal hidden" style="display: none;">
        <div class="modal-content paywall-content">
            <h2>Out of Credits</h2>
            <p>You have run out of credits. Purchase more to continue generating high-quality depth maps.</p>
            <button id="buy-credits-btn" class="action-btn primary-btn">Buy Credits</button>
            <button id="close-paywall-btn" class="action-btn secondary-btn">Close</button>
        </div>
    </div>
    `;
        indexHtml = indexHtml.replace('</body>', `${paywallHtml}\n</body>`);
    }

    const jsInjection = `
<script>
document.addEventListener('DOMContentLoaded', () => {
    const creditBalanceEl = document.getElementById('credit-balance');
    const paywallModal = document.getElementById('paywall-modal');
    const buyCreditsBtn = document.getElementById('buy-credits-btn');
    const closePaywallBtn = document.getElementById('close-paywall-btn');
    const creditDisplay = document.getElementById('credit-display');

    async function fetchCredits() {
        try {
            const token = localStorage.getItem('supabase_token');
            const headers = {};
            if (token) headers['Authorization'] = 'Bearer ' + token;
            
            const res = await fetch('/api/wallet/balance', { headers });
            if (res.ok) {
                const data = await res.json();
                updateCreditDisplay(data.balance);
            }
        } catch (err) {
            console.error('Failed to fetch credits:', err);
        }
    }

    function updateCreditDisplay(balance) {
        if (creditBalanceEl) {
            creditBalanceEl.textContent = balance;
        }
        if (balance === 0 && creditDisplay) {
            creditDisplay.classList.add('out-of-credits');
        } else if (creditDisplay) {
            creditDisplay.classList.remove('out-of-credits');
        }
    }

    function showPaywall() {
        if (paywallModal) {
            paywallModal.classList.remove('hidden');
            paywallModal.style.display = 'flex';
        }
    }

    if (closePaywallBtn) {
        closePaywallBtn.addEventListener('click', () => {
            paywallModal.classList.add('hidden');
            paywallModal.style.display = 'none';
        });
    }

    if (buyCreditsBtn) {
        buyCreditsBtn.addEventListener('click', async () => {
            try {
                const token = localStorage.getItem('supabase_token');
                const headers = { 'Content-Type': 'application/json' };
                if (token) headers['Authorization'] = 'Bearer ' + token;
                
                const res = await fetch('/api/wallet/checkout', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ packageId: 'basic' })
                });
                const data = await res.json();
                if (data.url) {
                    window.location.href = data.url;
                }
            } catch (err) {
                console.error('Checkout failed:', err);
            }
        });
    }

    if (creditDisplay) {
        creditDisplay.addEventListener('click', () => {
            showPaywall();
        });
    }

    const originalFetch = window.fetch;
    window.fetch = async function() {
        const response = await originalFetch.apply(this, arguments);
        
        if (response.status === 402) {
            showPaywall();
        }
        
        const clone = response.clone();
        clone.json().then(data => {
            if (data && data.credits_balance !== undefined) {
                updateCreditDisplay(data.credits_balance);
            }
        }).catch(() => {});
        
        return response;
    };

    fetchCredits();
});
</script>
`;

    if (!indexHtml.includes('fetchCredits()')) {
        indexHtml = indexHtml.replace('</body>', `${jsInjection}\n</body>`);
    }

    fs.writeFileSync(indexHtmlPath, indexHtml);
}

const styleCssPath = path.join(process.cwd(), 'static', 'style.css');
if (fs.existsSync(styleCssPath)) {
    let styleCss = fs.readFileSync(styleCssPath, 'utf8');

    if (!styleCss.includes('.credit-display')) {
        styleCss += `
/* Credit UI */
.credit-display {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 1rem;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 20px;
    font-weight: bold;
    cursor: pointer;
    transition: background 0.3s;
}
.credit-display:hover {
    background: rgba(255, 255, 255, 0.2);
}
.credit-display.out-of-credits {
    color: #ff4444;
    background: rgba(255, 68, 68, 0.1);
}
.paywall-content {
    text-align: center;
    padding: 2rem;
    max-width: 400px;
    background: #1a1a1a;
    border-radius: 12px;
    border: 1px solid #333;
    color: white;
}
.paywall-content h2 {
    margin-top: 0;
    color: #fff;
}
.paywall-content p {
    margin-bottom: 1.5rem;
    color: #ccc;
}
.paywall-content .action-btn {
    width: 100%;
    margin-bottom: 0.5rem;
    padding: 10px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-weight: bold;
}
.paywall-content .primary-btn {
    background: #4CAF50;
    color: white;
}
.paywall-content .secondary-btn {
    background: #555;
    color: white;
}
#paywall-modal {
    position: fixed;
    top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
}
#paywall-modal.hidden {
    display: none !important;
}
`;
        fs.writeFileSync(styleCssPath, styleCss);
    }
}

try {
    execSync('node sync_android.js', { stdio: 'inherit' });
} catch (e) {
    console.error('Failed to sync to android:', e);
}
