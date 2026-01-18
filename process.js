require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const logDonation = (data) => {
    const csvPath = path.join(__dirname, 'donation.csv');
    const fileExists = fs.existsSync(csvPath);
    const headers = 'Timestamp,DonorName,Email,Phone,AutoRenew,StartDate,LastInstallmentDate,MonthlyAmount,TotalPledge,Installments\n';
    
    const row = `"${new Date().toLocaleString()}",` +
                `"${data.donorName.replace(/"/g, '""')}",` +
                `"${data.email}",` +
                `"${data.phone}",` +
                `"${data.autoRenew}",` +
                `"${data.startDate}",` +
                `"${data.endDate}",` + 
                `"${data.monthlyAmount}",` +
                `"${data.totalPledge}",` +
                `"${data.installments}"\n`;

    if (!fileExists) {
        fs.writeFileSync(csvPath, headers + row);
    } else {
        fs.appendFileSync(csvPath, row);
    }
};

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'donation.html'));
});

app.post('/create-checkout-session', async (req, res) => {
    try {
        const { email, donorName, phone, monthlyAmount, startDate } = req.body;
        
        const [sYear, sMonth, sDay] = startDate.split('-').map(Number);
        const start = new Date(sYear, sMonth - 1, sDay);
        
        const today = new Date();
        today.setHours(0,0,0,0);
        const isToday = start <= today;
        
        const [fYear, fMonth, fDay] = config.fiscal_year_end.split('-').map(Number);
        const fiscalEnd = new Date(fYear, fMonth - 1, fDay);
        
        let monthsRemaining = (fiscalEnd.getFullYear() - start.getFullYear()) * 12 + (fiscalEnd.getMonth() - start.getMonth()) + 1;
        if (monthsRemaining <= 0) monthsRemaining = 1;

        // Calculate Actual Last Installment Date
        let lastDateObj = new Date(sYear, sMonth - 1, sDay);
        lastDateObj.setMonth(lastDateObj.getMonth() + (monthsRemaining - 1));
        const lastInstallmentDate = lastDateObj.toISOString().split('T')[0];

        const totalPledge = Math.round(parseFloat(monthlyAmount) * monthsRemaining);

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'us_bank_account'],
            customer_email: email,
            metadata: {
                donor_name: donorName,
                donor_phone: phone,
                donor_email: email,
                auto_renew: "Y",
                start_date: startDate,
                last_installment_date: lastInstallmentDate, 
                monthly_amount: `$${monthlyAmount}`,
                total_pledge_value: `$${totalPledge}`
            },
            line_items: [{
                price_data: {
                    currency: 'usd',
                    recurring: { interval: 'month' },
                    unit_amount: Math.round(parseFloat(monthlyAmount) * 100),
                    product_data: { 
                        name: `Monthly Donation: $${monthlyAmount}`,
                        description: `Final installment scheduled for ${lastInstallmentDate}`
                    },
                },
                quantity: 1,
            }],
            mode: 'subscription',
            subscription_data: {
                billing_cycle_anchor: isToday ? undefined : Math.floor(start.getTime() / 1000),
                proration_behavior: isToday ? undefined : 'none',
                metadata: { 
                    donor_name: donorName,
                    last_installment_date: lastInstallmentDate
                }
            },
            // ADDED lastDate to success_url
            success_url: `${process.env.DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}&name=${encodeURIComponent(donorName)}&total=${totalPledge}&monthly=${monthlyAmount}&start=${startDate}&count=${monthsRemaining}&lastDate=${lastInstallmentDate}`,
            cancel_url: `${process.env.DOMAIN}/cancel.html`,
        });

        logDonation({
            donorName,
            email,
            phone,
            autoRenew: 'Y',
            startDate,
            endDate: lastInstallmentDate, 
            monthlyAmount: `$${monthlyAmount}`,
            totalPledge: `$${totalPledge}`,
            installments: monthsRemaining
        });

        res.json({ url: session.url });
    } catch (e) {
        console.error("Stripe Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/cancel-subscription', async (req, res) => {
    try {
        const { sessionId } = req.body;
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const subscriptionId = session.subscription;
        
        const fiscalEndTimestamp = Math.floor(new Date(config.fiscal_year_end).getTime() / 1000);
        
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at: fiscalEndTimestamp,
            metadata: { 
                auto_renew: "N",
                actual_end_date: config.fiscal_year_end
            }
        });

        fs.appendFileSync(path.join(__dirname, 'donation.csv'), 
            `"${new Date().toLocaleString()}","${session.metadata.donor_name}","${session.metadata.donor_email}","UPDATE","N (Cancelled)","---","---","---","---","---"\n`
        );
        
        res.json({ status: 'success' });
    } catch (e) {
        console.error("Cancellation Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server active: http://localhost:${PORT}`);
});