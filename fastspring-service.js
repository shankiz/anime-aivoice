const axios = require('axios');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');

// MongoDB Connection String
const uri = "mongodb+srv://animevoice:5bijez5BGK8kmsUe@cluster0.aquqj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);
let db;

// Connect to MongoDB
async function connectDB() {
    try {
        await client.connect();
        db = client.db('test'); // Replace with your actual database name
        console.log('Connected to MongoDB in FastSpring service');
    } catch (error) {
        console.error('MongoDB connection error:', error);
        throw error;
    }
}

// FastSpring Configuration
const config = {
    username: process.env.FASTSPRING_USERNAME || 'YPNVTRGOQE6IOLR6N4BBZA',
    password: process.env.FASTSPRING_PASSWORD || 'dhfQIOKYQnWbiqg7sOELpQ',
    storefront: 'aianimevoice.test.onfastspring.com',
    products: {
        premium: 'ai-anime-voice-premium',
        ultimate: 'ai-anime-voice-ultimate'
    }
};

class FastSpringService {
    constructor() {
        this.username = config.username;
        this.password = config.password;
        this.baseURL = 'https://api.fastspring.com';
    }

    // Get subscription details
    async getSubscription(subscriptionId) {
        console.log('\n=== FastSpring: Getting Subscription ===');
        console.log('Subscription ID:', subscriptionId);

        try {
            const response = await axios({
                method: 'GET',
                url: `${this.baseURL}/subscriptions/${subscriptionId}`,
                auth: {
                    username: this.username,
                    password: this.password
                }
            });

            console.log('FastSpring API Response:', {
                status: response.status,
                data: response.data
            });

            return response.data;
        } catch (error) {
            console.error('FastSpring API Error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            throw error;
        }
    }

    // Create a subscription
    async createSubscription(userId, productId, email) {
        console.log('\n=== FastSpring: Creating Subscription ===');
        console.log('User ID:', userId);
        console.log('Product ID:', productId);
        console.log('Email:', email);

        try {
            const payload = {
                subscription: {
                    product: productId,
                    customer: {
                        email: email
                    },
                    tags: {
                        userId: userId
                    }
                }
            };

            const response = await axios({
                method: 'POST',
                url: `${this.baseURL}/subscriptions`,
                data: payload,
                auth: {
                    username: this.username,
                    password: this.password
                }
            });

            console.log('FastSpring API Response:', {
                status: response.status,
                data: response.data
            });

            // Update user's plan in database
            if (!db) {
                await connectDB();
            }

            const plan = productId.includes('premium') ? 'premium' : 'ultimate';
            await db.collection('users').updateOne(
                { _id: new ObjectId(userId) },
                {
                    $set: {
                        currentPlan: plan,
                        subscriptionId: response.data.id,
                        subscriptionStatus: 'active',
                        updatedAt: new Date()
                    }
                }
            );

            return response.data;
        } catch (error) {
            console.error('FastSpring API Error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            throw error;
        }
    }

    // Cancel subscription
    async cancelSubscription(subscriptionId) {
        console.log('\n=== FastSpring: Canceling Subscription ===');
        console.log('Subscription ID:', subscriptionId);

        try {
            const response = await axios({
                method: 'DELETE',
                url: `${this.baseURL}/subscriptions/${subscriptionId}`,
                auth: {
                    username: this.username,
                    password: this.password
                }
            });

            console.log('FastSpring API Response:', {
                status: response.status,
                data: response.data
            });

            // Update user's plan in database
            if (!db) {
                await connectDB();
            }

            await db.collection('users').updateOne(
                { subscriptionId },
                {
                    $set: {
                        subscriptionStatus: 'canceled',
                        updatedAt: new Date()
                    }
                }
            );

            return response.data;
        } catch (error) {
            console.error('FastSpring API Error:', {
                message: error.message,
                response: error.response?.data,
                status: error.response?.status
            });
            throw error;
        }
    }

    verifyWebhookSignature(payload, signature) {
        if (!process.env.FASTSPRING_WEBHOOK_SECRET) {
            console.warn('No webhook secret configured');
            return true; // Skip verification in development
        }

        try {
            const hmac = crypto.createHmac('sha256', process.env.FASTSPRING_WEBHOOK_SECRET);
            const calculatedSignature = hmac.update(JSON.stringify(payload)).digest('hex');
            return calculatedSignature === signature;
        } catch (error) {
            console.error('Webhook signature verification error:', error);
            return false;
        }
    }
}

// Connect to MongoDB when the module loads
connectDB().catch(console.error);

module.exports = new FastSpringService();
