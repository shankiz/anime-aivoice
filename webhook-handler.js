const express = require('express');
const router = express.Router();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const fastSpringService = require('./fastspring-service');
const WebSocket = require('ws');
const nodemailer = require('nodemailer');

// Create WebSocket server
const wss = new WebSocket.Server({ noServer: true });

// MongoDB Connection String
const uri = "mongodb+srv://animevoice:5bijez5BGK8kmsUe@cluster0.aquqj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Store WebSocket connections
const clients = new Map();

// Handle WebSocket connection
wss.on('connection', (ws, userId) => {
    console.log('WebSocket client connected, userId:', userId);
    clients.set(userId, ws);

    ws.on('close', () => {
        console.log('WebSocket client disconnected, userId:', userId);
        clients.delete(userId);
    });
});

// Export WebSocket server for use in index.js
router.wss = wss;

let db;

async function connectDB() {
    if (!db) {
        await client.connect();
        db = client.db("anime_voice");
    }
    return db;
}

// Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Helper function to send subscription end email
async function sendSubscriptionEndEmail(email) {
    console.log('🔄 Attempting to send subscription end email to:', email);
    try {
        await transporter.sendMail({
            from: `"Chatguru" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Your Subscription Has Ended - Chatguru',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #333;">Your Subscription Has Ended</h2>
                    <p>Hello,</p>
                    <p>Your Chatguru subscription has ended and your account has been changed to a free plan. Here's what this means:</p>
                    <ul>
                        <li>Your plan has been changed to free</li>
                        <li>Your unlocked characters have been reset</li>
                        <li>You now have the basic free tier benefits:
                            <ul>
                                <li>20 messages per day</li>
                                <li>20 diamonds</li>
                                <li>Basic response time</li>
                            </ul>
                        </li>
                    </ul>
                    <p>Want to continue enjoying premium features? You can resubscribe anytime!</p>
                    <p>
                        <a href="${process.env.APP_URL}/subscription.html" 
                           style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">
                            Resubscribe Now
                        </a>
                    </p>
                    <p>Thank you for being a Chatguru user!</p>
                </div>
            `
        });
        console.log('✅ Subscription end email sent');
    } catch (error) {
        console.error('Error sending subscription end email:', error);
    }
}

// Webhook handler
router.post('/fastspring', async (req, res) => {
    try {
        // Verify webhook signature in production
        if (process.env.NODE_ENV === 'production') {
            const signature = req.headers['x-fs-signature'];
            if (!signature || !fastSpringService.verifyWebhookSignature(req.body, signature)) {
                console.error('Invalid webhook signature');
                return res.status(401).json({ error: 'Invalid signature' });
            }
        }

        const events = req.body.events || [];
        console.log('📩 Received webhook events:', events.map(e => ({
            type: e.type,
            subscriptionId: e.data?.id,
            userId: e.data?.tags?.userId
        })));

        for (const event of events) {
            await handleWebhook(event);
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

async function handleWebhook(event) {
    try {
        await connectDB();

        if (event.type === 'order.completed') {
            const orderData = event.data;
            const tags = orderData.tags || {};
            const userId = tags.userId;

            if (!userId) {
                console.error('❌ No userId found in webhook tags');
                return;
            }

            // Get the first item from the order
            const item = orderData.items && orderData.items[0];
            if (!item) {
                console.error('❌ No items found in order');
                return;
            }

            // Determine the plan from the product
            const plan = item.product.includes('premium') ? 'premium' : 'ultimate';

            console.log('💫 Processing subscription update:', {
                userId,
                plan,
                orderId: orderData.id
            });

            // Get current user data to preserve unlocked characters
            const currentUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            const currentUnlockedCharacters = currentUser?.unlockedCharacters || [];

            // Define all available characters
            const allCharacters = [
                'naruto',
                'sasuke',
                'zoro',
                'gojo',
                'bakugo',
                'mitsuri',
                'robin',
                'shinobu'
            ];

            // Define plan benefits
            const planBenefits = {
                free: {
                    messagesPerDay: 20,
                    diamonds: 20,
                    responseTime: 'basic',
                    unlockedCharacters: [] // No characters included
                },
                premium: {
                    messagesPerDay: 150,
                    diamonds: 100,
                    responseTime: 'fast',
                    unlockedCharacters: [] // No characters included
                },
                ultimate: {
                    messagesPerDay: 300,
                    diamonds: 0, // No diamonds needed as all characters are unlocked
                    responseTime: 'fastest',
                    unlockedCharacters: allCharacters // All characters included
                }
            };

            const benefits = planBenefits[plan.toLowerCase()];

            // If upgrading to ultimate, give all characters
            // Otherwise, keep their currently unlocked characters
            const unlockedCharacters = plan.toLowerCase() === 'ultimate' ? 
                allCharacters : currentUnlockedCharacters;

            // Update user's plan and benefits in database
            await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                {
                    $set: {
                        plan: plan.toLowerCase(),
                        currentPlan: plan.toLowerCase(),
                        subscriptionStatus: 'active',
                        subscriptionId: item.subscription,
                        orderId: orderData.id,
                        messagesLeft: benefits.messagesPerDay,
                        diamonds: benefits.diamonds,
                        responseTime: benefits.responseTime,
                        unlockedCharacters: unlockedCharacters,
                        updatedAt: new Date()
                    }
                }
            );

            const updatedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            console.log('✅ Subscription updated successfully:', {
                email: updatedUser.email,
                plan: updatedUser.plan,
                benefits: {
                    messagesLeft: updatedUser.messagesLeft,
                    diamonds: updatedUser.diamonds,
                    responseTime: updatedUser.responseTime,
                    unlockedCharacters: updatedUser.unlockedCharacters
                }
            });

            // Send WebSocket message to client
            const ws = clients.get(userId);
            if (ws) {
                ws.send(JSON.stringify({
                    type: 'subscription_updated',
                    data: {
                        plan: updatedUser.plan,
                        email: updatedUser.email,
                        userId: userId,
                        orderId: orderData.id,
                        benefits: {
                            messagesLeft: updatedUser.messagesLeft,
                            diamonds: updatedUser.diamonds,
                            responseTime: updatedUser.responseTime,
                            unlockedCharacters: updatedUser.unlockedCharacters
                        }
                    }
                }));

                // Send an additional refresh command to ensure UI updates
                ws.send(JSON.stringify({
                    type: 'refresh_required',
                    data: { reason: 'plan_upgrade' }
                }));
            }
        } else if (event.type === 'subscription.activated' || event.type === 'subscription.updated') {
            const subscriptionData = event.data;
            const tags = subscriptionData.tags || {};
            const userId = tags.userId;

            if (!userId) {
                console.error('❌ No userId found in webhook tags');
                return;
            }

            // Determine the plan from the product
            const plan = subscriptionData.product.includes('premium') ? 'premium' : 'ultimate';

            // Get current user data to preserve unlocked characters
            const currentUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            const currentUnlockedCharacters = currentUser?.unlockedCharacters || [];

            // Define all available characters
            const allCharacters = [
                'naruto',
                'sasuke',
                'zoro',
                'gojo',
                'bakugo',
                'mitsuri',
                'robin',
                'shinobu'
            ];

            // Define plan benefits
            const planBenefits = {
                free: {
                    messagesPerDay: 20,
                    diamonds: 20,
                    responseTime: 'basic',
                    unlockedCharacters: [] // No characters included
                },
                premium: {
                    messagesPerDay: 150,
                    diamonds: 100,
                    responseTime: 'fast',
                    unlockedCharacters: [] // No characters included
                },
                ultimate: {
                    messagesPerDay: 300,
                    diamonds: 0, // No diamonds needed as all characters are unlocked
                    responseTime: 'fastest',
                    unlockedCharacters: allCharacters // All characters included
                }
            };

            const benefits = planBenefits[plan.toLowerCase()];

            // If upgrading to ultimate, give all characters
            // Otherwise, keep their currently unlocked characters
            const unlockedCharacters = plan.toLowerCase() === 'ultimate' ? 
                allCharacters : currentUnlockedCharacters;

            // Update user's plan and benefits in database
            await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                {
                    $set: {
                        plan: plan.toLowerCase(),
                        currentPlan: plan.toLowerCase(),
                        subscriptionStatus: subscriptionData.state,
                        subscriptionId: subscriptionData.id,
                        messagesLeft: benefits.messagesPerDay,
                        diamonds: benefits.diamonds,
                        responseTime: benefits.responseTime,
                        unlockedCharacters: unlockedCharacters,
                        updatedAt: new Date()
                    }
                }
            );

            const updatedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            console.log('✅ Subscription updated successfully:', {
                email: updatedUser.email,
                plan: updatedUser.plan,
                benefits: {
                    messagesLeft: updatedUser.messagesLeft,
                    diamonds: updatedUser.diamonds,
                    responseTime: updatedUser.responseTime,
                    unlockedCharacters: updatedUser.unlockedCharacters
                }
            });
        } else if (event.type === 'subscription.deactivated' || event.type === 'subscription.canceled') {
            const subscriptionData = event.data;
            const tags = subscriptionData.tags || {};
            const userId = tags.userId;

            if (!userId) {
                console.error('❌ No userId found in webhook tags');
                return;
            }

            // Get current user data to preserve unlocked characters
            const currentUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
            const currentUnlockedCharacters = currentUser?.unlockedCharacters || [];

            console.log('💫 Processing subscription event:', {
                userId,
                subscriptionId: subscriptionData.id,
                eventType: event.type,
                state: subscriptionData.state
            });

            // Only downgrade to free if subscription is actually ending (deactivated)
            // If it's just marked for cancellation, keep current plan until period ends
            if (event.type === 'subscription.deactivated') {
                // Get user email for notification
                const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

                // Update user's plan to free with basic benefits and reset characters to zero
                await db.collection('users').updateOne(
                    { _id: new ObjectId(userId) },
                    {
                        $set: {
                            plan: 'free',
                            currentPlan: 'free',
                            subscriptionStatus: 'deactivated',
                            messagesLeft: 20,
                            diamonds: 20,
                            responseTime: 'basic',
                            unlockedCharacters: [], // Reset characters to zero
                            updatedAt: new Date()
                        },
                        $unset: { subscriptionId: "" }
                    }
                );

                console.log('✅ User downgraded to free plan with characters reset to zero');

                // Send email notification
                if (user && user.email) {
                    await sendSubscriptionEndEmail(user.email);
                }

                // Notify user via WebSocket if they're online
                const ws = clients.get(userId);
                if (ws) {
                    ws.send(JSON.stringify({
                        type: 'subscription_update',
                        data: { 
                            reason: 'subscription_ended',
                            message: 'Your subscription has ended. Your plan has been changed to free and your unlocked characters have been reset.'
                        }
                    }));
                }
            } else {
                // Just mark as cancelled but keep current plan
                await db.collection('users').updateOne(
                    { _id: new ObjectId(userId) },
                    {
                        $set: {
                            subscriptionStatus: 'cancelled',
                            updatedAt: new Date()
                        }
                    }
                );

                // Notify user via WebSocket if they're online
                const ws = clients.get(userId);
                if (ws) {
                    ws.send(JSON.stringify({
                        type: 'subscription_update',
                        data: { 
                            reason: 'subscription_cancelled',
                            message: 'Your subscription has been cancelled. You will keep your premium features until the end of your billing period.'
                        }
                    }));
                }

                console.log('✅ Subscription marked as cancelled');
            }
        }
    } catch (error) {
        console.error('Error handling webhook:', error);
        throw error;
    }
}

module.exports = router;
