const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
require('dotenv').config();
const session = require('express-session');
const MongoStore = require('connect-mongo');
const userFunctions = require('./user-functions');
const { handleWebhook } = require('./webhook-handler');

const app = express();
const port = process.env.PORT || 3000;

// MongoDB Connection String
const uri = "mongodb+srv://animevoice:5bijez5BGK8kmsUe@cluster0.aquqj.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Test email configuration on startup
transporter.verify((error, success) => {
    if (error) {
        console.error('Email configuration error:', error);
    } else {
        console.log('Email server is ready');
    }
});

// Helper function to send verification email
async function sendVerificationEmail(email, verificationCode) {
    try {
        const mailOptions = {
            from: `"Chatguru" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: 'Verify Your Email - Chatguru',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h2 style="color: #00c3ff; text-align: center;">Welcome to Chatguru!</h2>
                    <div style="background-color: #f8f9fa; border-radius: 10px; padding: 20px; margin: 20px 0;">
                        <p style="font-size: 16px; color: #333;">Your verification code is:</p>
                        <div style="
                            background-color: #fff;
                            border: 2px solid #00c3ff;
                            border-radius: 10px;
                            padding: 20px;
                            text-align: center;
                            margin: 20px 0;
                            font-size: 32px;
                            letter-spacing: 5px;
                            font-family: monospace;
                            color: #00c3ff;">
                            ${verificationCode}
                        </div>
                        <p style="color: #666; font-size: 14px;">This code will be valid until you verify your email.</p>
                    </div>
                    <p style="color: #999; font-size: 12px; text-align: center;">
                        If you didn't request this code, please ignore this email.
                    </p>
                </div>
            `
        };

        const info = await transporter.sendMail(mailOptions);
        console.log('Verification email sent:', info.messageId);
        return true;
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw error;
    }
}

// Helper function to generate 6-digit verification code
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Temporary storage for pending verifications (in-memory)
const pendingVerifications = new Map();

// Helper function to clean up expired verifications
function cleanupExpiredVerifications() {
    // Only clean up entries older than 24 hours to prevent memory leaks
    const now = new Date();
    const oneDayAgo = new Date(now - 24 * 60 * 60 * 1000);
    for (const [email, data] of pendingVerifications.entries()) {
        if (data.createdAt < oneDayAgo) {
            pendingVerifications.delete(email);
        }
    }
}

// Clean up once per day
setInterval(cleanupExpiredVerifications, 24 * 60 * 60 * 1000);

// Input validation helpers
const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
};

const validatePassword = (password) => {
    return password.length >= 6;
};

const validateName = (name) => {
    return name.trim().length >= 2;
};

// Basic express setup
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// Add raw body parsing for FastSpring webhooks
app.use((req, res, next) => {
    if (req.path === '/api/fastspring/webhook' && req.method === 'POST') {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', chunk => {
            data += chunk;
        });
        req.on('end', () => {
            req.body = data;
            next();
        });
    } else {
        next();
    }
});

// FastSpring webhook endpoint
app.post('/api/fastspring/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('\n=== Received FastSpring Webhook ===');
    console.log('Timestamp:', new Date().toISOString());
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('Raw Body:', req.body.toString());

    try {
        await handleWebhook(req, res);
    } catch (error) {
        console.error('Error handling webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Also add a GET endpoint to test if the webhook URL is reachable
app.get('/api/fastspring/webhook', (req, res) => {
    console.log('\n=== Webhook Test GET Request ===');
    console.log('Headers:', req.headers);
    res.send('FastSpring webhook endpoint is working');
});

// Auth middleware - SIMPLIFIED
const requireAuth = async (req, res, next) => {
    if (!req.session || !req.session.user || !req.session.user.id) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    try {
        // Verify user exists in database
        const user = await getFullUserData(req.session.user.id);
        if (!user) {
            req.session.destroy();
            return res.status(401).json({ message: 'User not found' });
        }
        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

// Auth middleware for pages - redirects to login instead of JSON response
const requireAuthPage = async (req, res, next) => {
    if (!req.session || !req.session.user || !req.session.user.id) {
        return res.redirect('/');
    }

    try {
        // Verify user exists in database
        const user = await getFullUserData(req.session.user.id);
        if (!user) {
            req.session.destroy();
            return res.redirect('/');
        }
        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        return res.redirect('/');
    }
};

// Session setup with MongoDB store
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
        mongoUrl: uri,
        ttl: 24 * 60 * 60 // 1 day
    }),
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Import and use anime-models routes with authentication
const animeModels = require('./anime-models');
app.use('/anime-models', requireAuth, animeModels);

// Database connection
let db;
let isConnecting = false;
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;

async function connectDB(retryCount = 0) {
    if (db) return db;
    if (isConnecting) {
        // Wait for existing connection attempt
        await new Promise(resolve => setTimeout(resolve, 1000));
        return db;
    }

    isConnecting = true;
    try {
        await client.connect();
        db = client.db("anime_voice");
        console.log("Successfully connected to MongoDB!");
        isConnecting = false;
        return db;
    } catch (error) {
        isConnecting = false;
        console.error("Error connecting to MongoDB:", error);

        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying connection in ${RETRY_DELAY/1000} seconds... (Attempt ${retryCount + 1}/${MAX_RETRIES})`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return connectDB(retryCount + 1);
        }
        throw error;
    }
}

// Ensure database connection before handling requests
app.use(async (req, res, next) => {
    try {
        if (!db || !client.topology || !client.topology.isConnected()) {
            await connectDB();
        }
        next();
    } catch (error) {
        console.error("Database connection error:", error);
        res.status(503).json({ message: "Database service unavailable" });
    }
});

// Cleanup function for the MongoDB connection
async function cleanup() {
    try {
        if (client) {
            console.log('Closing MongoDB connection...');
            await client.close();
            db = null;
            console.log('MongoDB connection closed.');
        }
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
    process.exit(0);
}

// Handle application shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

// Periodic connection check
setInterval(async () => {
    try {
        if (!db || !client.topology || !client.topology.isConnected()) {
            console.log('Detected disconnected database, attempting to reconnect...');
            await connectDB();
        }
    } catch (error) {
        console.error('Error in periodic connection check:', error);
    }
}, 30000); // Check every 30 seconds

// Database helpers
async function findUserByEmail(email) {
    try {
        return await db.collection('users').findOne({ email: email.toLowerCase() });
    } catch (error) {
        console.error('Database error in findUserByEmail:', error);
        throw new Error('Database error while checking user existence');
    }
}

async function createUser(userData) {
    try {
        const result = await db.collection('users').insertOne(userData);
        return result.insertedId;
    } catch (error) {
        console.error('Database error in createUser:', error);
        throw new Error('Database error while creating user');
    }
}

async function updateUser(userId, updateData) {
    try {
        const result = await db.collection('users').updateOne(
            { _id: userId },
            { $set: updateData }
        );
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Database error in updateUser:', error);
        throw new Error('Database error while updating user');
    }
}

async function findUserById(userId) {
    try {
        return await db.collection('users').findOne({ _id: new ObjectId(userId) });
    } catch (error) {
        console.error('Database error in findUserById:', error);
        throw new Error('Database error while finding user by ID');
    }
}

// User data management functions
async function updateUserDiamonds(userId, diamonds) {
    try {
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { 
                $set: { 
                    diamonds: diamonds,
                    updatedAt: new Date()
                }
            }
        );
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error updating user diamonds:', error);
        throw new Error('Failed to update user diamonds');
    }
}

async function updateUserPlan(userId, plan) {
    try {
        // First get the user's current data to preserve unlocked characters
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

        const planBenefits = {
            free: {
                messagesPerDay: 20,
                diamonds: 20,
                responseTime: 'standard',
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
        if (!benefits) {
            throw new Error('Invalid plan type');
        }

        // If upgrading to ultimate, give all characters
        // Otherwise, keep their currently unlocked characters
        const unlockedCharacters = plan.toLowerCase() === 'ultimate' ? 
            allCharacters : currentUnlockedCharacters;

        const updateData = {
            currentPlan: plan.toLowerCase(),
            messagesLeft: benefits.messagesPerDay,
            diamonds: benefits.diamonds,
            responseTime: benefits.responseTime,
            unlockedCharacters: unlockedCharacters,
            updatedAt: new Date()
        };

        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: updateData }
        );

        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error updating user plan:', error);
        throw new Error('Failed to update user plan');
    }
}

async function unlockCharacter(userId, character) {
    try {
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { 
                $addToSet: { 
                    unlockedCharacters: character
                },
                $set: {
                    updatedAt: new Date()
                }
            }
        );
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error unlocking character:', error);
        throw new Error('Failed to unlock character');
    }
}

// Get full user data including all attributes
async function getFullUserData(userId) {
    try {
        return await db.collection('users').findOne(
            { _id: new ObjectId(userId) },
            { 
                projection: {
                    password: 0 // Exclude password from the result
                }
            }
        );
    } catch (error) {
        console.error('Error fetching user data:', error);
        throw new Error('Failed to fetch user data');
    }
}

// Get user data - SIMPLIFIED
app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const userData = await userFunctions.getFullUserData(req.session.user.id);
        if (!userData) {
            return res.status(404).json({ message: 'User not found' });
        }
        res.json(userData);
    } catch (error) {
        console.error('Error fetching user data:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Add route to unlock a character
app.post('/api/user/unlock-character', requireAuth, async (req, res) => {
    try {
        const { character } = req.body;
        const userId = req.session.user.id;

        // Get current user data
        const userData = await getFullUserData(userId);

        // Check if user has enough diamonds (cost is 10)
        if (userData.diamonds < 10) {
            return res.status(400).json({ 
                message: 'Not enough diamonds. You need 10 diamonds to unlock a character.' 
            });
        }

        // Check if character is already unlocked
        if (userData.unlockedCharacters.includes(character)) {
            return res.status(400).json({ 
                message: 'Character is already unlocked.' 
            });
        }

        // Update diamonds and unlock character
        await Promise.all([
            updateUserDiamonds(userId, userData.diamonds - 10),
            unlockCharacter(userId, character)
        ]);

        // Get updated user data
        const updatedUserData = await getFullUserData(userId);

        // Update session with new data
        req.session.user = {
            ...req.session.user,
            diamonds: updatedUserData.diamonds,
            unlockedCharacters: updatedUserData.unlockedCharacters
        };

        res.json({ 
            success: true,
            user: updatedUserData
        });
    } catch (error) {
        console.error('Error unlocking character:', error);
        res.status(500).json({ message: 'Failed to unlock character' });
    }
});

// Add middleware to refresh user data on each request
app.use(async (req, res, next) => {
    if (req.session && req.session.user) {
        try {
            const freshUserData = await getFullUserData(req.session.user.id);
            req.session.user = {
                id: freshUserData._id.toString(),
                email: freshUserData.email,
                name: freshUserData.name,
                minutesLeft: freshUserData.minutesLeft,
                diamonds: freshUserData.diamonds,
                currentPlan: freshUserData.currentPlan,
                unlockedCharacters: freshUserData.unlockedCharacters
            };
        } catch (error) {
            console.error('Error refreshing user data:', error);
        }
    }
    next();
});

// Login route - SIMPLIFIED
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await findUserByEmail(email);

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }

        if (!user.verified) {
            return res.status(401).json({ message: 'Please verify your email first' });
        }

        // Set session with all user data
        req.session.user = {
            id: user._id.toString(),
            email: user.email,
            name: user.name,
            minutesLeft: user.minutesLeft || 30,
            diamonds: typeof user.diamonds === 'number' ? user.diamonds : 20,
            currentPlan: user.currentPlan || 'free',
            unlockedCharacters: user.unlockedCharacters || []
        };

        // Save session explicitly
        await new Promise((resolve, reject) => {
            req.session.save((err) => {
                if (err) reject(err);
                resolve();
            });
        });

        // Always return fresh data from database
        const userData = await getFullUserData(user._id);
        res.json({ 
            success: true,
            user: userData
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Individual character routes
app.get('/gojo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/gojo.html'));
});

app.get('/sasuke', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/sasuke.html'));
});

app.get('/bakugo', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/bakugo.html'));
});

app.get('/naruto', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/naruto.html'));
});

app.get('/zoro', (req, res) => {
    res.sendFile(path.join(__dirname, 'public/zoro.html'));
});

app.get('/mitsuri', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'mitsuri.html'));
});

app.get('/robin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'robin.html'));
});

app.get('/shinobu', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'shinobu.html'));
});

// Character request endpoint
app.post('/api/request-character', async (req, res) => {
    try {
        const { characterName, message } = req.body;
        const requestsPath = path.join(__dirname, 'public', 'requests', 'requests.json');

        // Read existing requests
        let requestsData = { requests: [] };
        try {
            const data = await fs.readFile(requestsPath, 'utf8');
            requestsData = JSON.parse(data);
        } catch (err) {
            // If file doesn't exist or is invalid, use empty array
        }

        // Add new request with timestamp and user info
        requestsData.requests.push({
            characterName,
            message,
            userId: req.session.user.id,
            userEmail: req.session.user.email,
            timestamp: new Date().toISOString()
        });

        // Write back to file
        await fs.writeFile(requestsPath, JSON.stringify(requestsData, null, 2), 'utf8');

        res.json({ success: true });
    } catch (error) {
        console.error('Error handling character request:', error);
        res.status(500).json({ success: false, error: 'Failed to process request' });
    }
});

// Logout route - SIMPLIFIED
app.post('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Add referral reward function
async function addReferralReward(referrerId) {
    try {
        console.log('Adding referral reward for ID:', referrerId); // Add logging

        // Convert string ID to ObjectId if it's not already
        const referrerObjectId = typeof referrerId === 'string' ? new ObjectId(referrerId) : referrerId;

        const referrer = await db.collection('users').findOne({ _id: referrerObjectId });
        console.log('Found referrer:', referrer ? 'yes' : 'no'); // Add logging

        if (!referrer) {
            console.log('No referrer found for ID:', referrerId);
            return false;
        }

        // Add reward to pending rewards instead of direct balance
        const result = await db.collection('users').updateOne(
            { _id: referrerObjectId },
            {
                $push: {
                    pendingReferralRewards: {
                        amount: 50,
                        createdAt: new Date()
                    }
                },
                $set: {
                    updatedAt: new Date()
                }
            }
        );

        console.log('Update result:', result.modifiedCount > 0 ? 'success' : 'failed'); // Add logging
        return result.modifiedCount > 0;
    } catch (error) {
        console.error('Error adding referral reward:', error);
        return false;
    }
}

// Add endpoint to claim rewards
app.post('/api/claim-rewards', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        // Get pending rewards
        const pendingRewards = user.pendingReferralRewards || [];
        if (pendingRewards.length === 0) {
            return res.status(400).json({ message: 'No rewards to claim' });
        }

        // Calculate total rewards
        const totalReward = pendingRewards.reduce((sum, reward) => sum + reward.amount, 0);
        const currentMessages = user.messagesLeft || 0;
        const currentEarnedMessages = user.earnedMessages || 0;
        const newEarnedMessages = currentEarnedMessages + totalReward;
        const newMessagesLeft = currentMessages + totalReward;

        // Update user data: clear pending rewards and update messages
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $set: {
                    pendingReferralRewards: [], // Clear pending rewards
                    messagesLeft: newMessagesLeft,
                    earnedMessages: newEarnedMessages,
                    updatedAt: new Date()
                }
            }
        );

        // Get updated user data
        const updatedUser = await getFullUserData(userId);

        res.json({
            success: true,
            message: `Successfully claimed ${totalReward} messages`,
            messagesLeft: updatedUser.messagesLeft,
            lastClaimTime: updatedUser.lastClaimTime
        });

    } catch (error) {
        console.error('Error claiming rewards:', error);
        res.status(500).json({ message: 'Failed to claim rewards' });
    }
});

// Add endpoint to check pending rewards
app.get('/api/check-rewards', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        const pendingRewards = user.pendingReferralRewards || [];
        const totalPending = pendingRewards.reduce((sum, reward) => sum + reward.amount, 0);

        res.json({ 
            pendingRewards,
            totalPending,
            earnedMessages: user.earnedMessages || 0
        });

    } catch (error) {
        console.error('Error checking rewards:', error);
        res.status(500).json({ message: 'Failed to check rewards' });
    }
});

// Add endpoint to get pending rewards
app.get('/api/pending-rewards', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const pendingRewards = user.pendingReferralRewards || [];
        const totalEarnedMessages = pendingRewards.reduce((total, reward) => total + reward.amount, 0);

        res.json({
            pendingRewards,
            totalEarnedMessages
        });
    } catch (error) {
        console.error('Error getting pending rewards:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

// Add endpoint to claim daily messages
app.post('/api/claim-daily-messages', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        const CLAIM_COOLDOWN = 2 * 60 * 1000; // 2 minutes in milliseconds
        const now = new Date();
        const lastClaimTime = user.lastClaimTime ? new Date(user.lastClaimTime) : null;

        if (lastClaimTime && (now - lastClaimTime) < CLAIM_COOLDOWN) {
            return res.status(400).json({
                success: false,
                message: 'Please wait before claiming again',
                remainingTime: CLAIM_COOLDOWN - (now - lastClaimTime)
            });
        }

        // Daily messages based on plan
        const dailyMessages = user.currentPlan === 'premium' ? 150 : user.currentPlan === 'ultimate' ? 300 : 20;

        // Get earned messages (from referrals etc)
        const earnedMessages = user.earnedMessages || 0;

        // Total messages is daily + earned
        const totalMessages = dailyMessages + earnedMessages;

        // Update user's messages and claim time
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { 
                $set: { 
                    messagesLeft: totalMessages, // Set to daily + earned
                    lastClaimTime: now
                }
            }
        );

        // Get updated user data
        const updatedUser = await getFullUserData(userId);

        res.json({ 
            success: true, 
            message: 'Successfully claimed daily messages',
            messagesLeft: updatedUser.messagesLeft,
            lastClaimTime: now
        });
    } catch (error) {
        console.error('Error claiming daily messages:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to claim daily messages' 
        });
    }
});

// Add endpoint to check claim status
app.get('/api/check-claim-status', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        const CLAIM_COOLDOWN = 2 * 60 * 1000; // 2 minutes in milliseconds
        const now = new Date();
        const lastClaimTime = user.lastClaimTime ? new Date(user.lastClaimTime) : null;

        if (!lastClaimTime || (now - lastClaimTime) >= CLAIM_COOLDOWN) {
            res.json({
                canClaim: true,
                remainingTime: 0
            });
        } else {
            const remainingTime = CLAIM_COOLDOWN - (now - lastClaimTime);
            res.json({
                canClaim: false,
                remainingTime
            });
        }
    } catch (error) {
        console.error('Error checking claim status:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to check claim status'
        });
    }
});

// Add endpoint to use message
app.post('/api/use-message', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const user = await getFullUserData(userId);

        // Check if user has any messages left
        if (!user.messagesLeft || user.messagesLeft <= 0) {
            return res.status(400).json({ message: 'No messages left' });
        }

        // Decrement messages
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $inc: {
                    messagesLeft: -1
                }
            }
        );

        // Get updated user data
        const updatedUser = await getFullUserData(userId);

        res.json({
            success: true,
            messagesLeft: updatedUser.messagesLeft
        });
    } catch (error) {
        console.error('Error using message:', error);
        res.status(500).json({ message: 'Failed to use message' });
    }
});

// Add endpoint to get call history
app.get('/api/call-history', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const userData = await getFullUserData(userId);

        if (!userData) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Sort calls by timestamp in descending order (newest first)
        const calls = userData.callHistory || [];
        calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({ calls });
    } catch (error) {
        console.error('Error fetching call history:', error);
        res.status(500).json({ error: 'Failed to fetch call history' });
    }
});

// Add endpoint to save call history
app.post('/api/call-history', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { character, message } = req.body;

        // Add new call to history
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $push: {
                    callHistory: {
                        character,
                        message,
                        timestamp: new Date()
                    }
                }
            }
        );

        res.json({ success: true });
    } catch (error) {
        console.error('Error saving call history:', error);
        res.status(500).json({ message: 'Failed to save call history' });
    }
});

// Add endpoint to delete call history entries
app.post('/api/call-history/delete', requireAuth, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { timestamps } = req.body;

        if (!Array.isArray(timestamps) || timestamps.length === 0) {
            return res.status(400).json({ error: 'Invalid timestamps provided' });
        }

        // Convert string timestamps to Date objects for comparison
        const timestampDates = timestamps.map(ts => new Date(ts));

        // Remove the specified entries from call history
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $pull: {
                    callHistory: {
                        timestamp: { $in: timestampDates }
                    }
                }
            }
        );

        res.json({ success: true, message: 'Call history entries deleted successfully' });
    } catch (error) {
        console.error('Error deleting call history:', error);
        res.status(500).json({ error: 'Failed to delete call history entries' });
    }
});

// FastSpring webhook handler
const webhookHandler = require('./webhook-handler');
app.use('/webhook', webhookHandler);

// Check FastSpring order status
app.post('/api/subscription/check-order', requireAuth, async (req, res) => {
    console.log('\n=== Checking Order Status ===');
    const { orderId } = req.body;
    console.log('Order ID:', orderId);

    if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
    }

    try {
        // Get order from FastSpring API
        const order = await fastSpringService.getOrder(orderId);
        console.log('FastSpring order:', order);

        if (!order) {
            return res.json({ success: false, error: 'Order not found' });
        }

        if (!order.completed) {
            return res.json({ success: false, error: 'Order not completed' });
        }

        // Get the plan from the order
        let plan = 'free';
        const items = order.items || [];

        if (!items.length) {
            return res.json({ success: false, error: 'No items in order' });
        }

        const item = items[0];
        if (!item || !item.product) {
            return res.json({ success: false, error: 'Invalid order data' });
        }

        if (item.product.includes('premium')) {
            plan = 'premium';
        } else if (item.product.includes('ultimate')) {
            plan = 'ultimate';
        }

        // Get user ID from order tags or session
        const userId = order.tags?.userId || req.session.user.id;
        if (!userId) {
            return res.json({ success: false, error: 'No user ID found' });
        }

        // Update user's plan
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $set: {
                    plan: plan,
                    currentPlan: plan,
                    subscriptionStatus: 'active',
                    subscriptionId: item.subscription,
                    orderId: orderId,
                    updatedAt: new Date()
                }
            }
        );

        console.log('Database update result:', result);

        if (result.matchedCount === 0) {
            return res.json({ success: false, error: 'User not found' });
        }

        // Get updated user data
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        console.log('Updated user data:', {
            id: user._id.toString(),
            email: user.email,
            plan: user.plan,
            currentPlan: user.currentPlan,
            subscriptionStatus: user.subscriptionStatus
        });

        res.json({
            success: true,
            plan: plan,
            orderId: orderId,
            subscriptionId: item.subscription
        });
    } catch (error) {
        console.error('Error checking order:', error);
        res.status(500).json({ error: 'Failed to check order', details: error.message });
    }
});

// Subscription status endpoint
app.get('/api/subscription/status', requireAuth, async (req, res) => {
    console.log('\n=== Getting Subscription Status ===');
    console.log('User:', req.session.user);

    try {
        const userId = req.session.user.id;
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        if (!user) {
            console.error('User not found:', userId);
            return res.status(404).json({ error: 'User not found' });
        }

        // Handle both old and new field names
        const userPlan = user.plan || user.currentPlan || 'free';

        console.log('User data:', {
            id: user._id.toString(),
            email: user.email,
            plan: userPlan,
            subscriptionStatus: user.subscriptionStatus
        });

        res.json({
            isLoggedIn: true,
            userId: user._id.toString(),
            email: user.email,
            plan: userPlan,
            subscriptionStatus: user.subscriptionStatus || 'none'
        });
    } catch (error) {
        console.error('Error getting subscription status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Update subscription
app.post('/api/subscription/update', requireAuth, async (req, res) => {
    console.log('\n=== Updating Subscription ===');
    console.log('User:', req.session.user);
    console.log('Body:', req.body);

    try {
        const { plan, orderId, subscriptionId } = req.body;
        const userId = req.session.user.id;

        if (!plan || !orderId) {
            console.error('Missing required fields');
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Update user's plan in database
        const result = await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            {
                $set: {
                    plan: plan,
                    currentPlan: plan, // Update both fields
                    subscriptionId: subscriptionId || orderId,
                    subscriptionStatus: 'active',
                    updatedAt: new Date()
                }
            }
        );

        console.log('Database update result:', result);

        if (result.matchedCount === 0) {
            console.error('User not found:', userId);
            throw new Error('User not found');
        }

        if (result.modifiedCount === 0) {
            console.warn('Document matched but not modified');
        } else {
            console.log('Successfully updated subscription to:', plan);
        }

        // Get updated user data
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
        console.log('Updated user data:', {
            id: user._id.toString(),
            email: user.email,
            plan: user.plan,
            currentPlan: user.currentPlan,
            subscriptionStatus: user.subscriptionStatus
        });

        res.json({ 
            success: true,
            plan: user.plan,
            currentPlan: user.currentPlan,
            subscriptionStatus: user.subscriptionStatus
        });
    } catch (error) {
        console.error('Error updating subscription:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Cancel subscription
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
    console.log('\n=== Canceling Subscription ===');
    try {
        const userId = req.session.user.id;
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        if (!user || !user.subscriptionId) {
            return res.status(400).json({ error: 'No active subscription found' });
        }

        console.log('User data:', { email: user.email, subscriptionId: user.subscriptionId });

        // Update user's subscription status
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { subscriptionStatus: 'cancelled', updatedAt: new Date() } }
        );

        // Send email notification
        if (user.email) {
            await transporter.sendMail({
                from: `"Chatguru" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: 'Subscription Cancellation Confirmation - Chatguru',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>Subscription Cancellation Confirmed</h2>
                        <p>Hello,</p>
                        <p>Your Chatguru subscription has been cancelled but will remain active until the end of your billing period.</p>
                        <p>After that:</p>
                        <ul>
                            <li>Plan changes to free</li>
                            <li>Unlocked characters reset</li>
                            <li>Free tier benefits: 20 messages/day, 20 diamonds</li>
                        </ul>
                        <p>Changed your mind? <a href="${process.env.APP_URL}/subscription.html">Reactivate your subscription</a></p>
                    </div>
                `
            });
            console.log('✅ Cancellation email sent');
        }

        console.log('✅ Subscription cancelled successfully');
        res.json({ success: true });
    } catch (error) {
        console.error('Error canceling subscription:', error);
        res.status(500).json({ error: 'Failed to cancel subscription', details: error.message });
    }
});

// Add endpoint to change subscription
app.post('/api/subscription/change', async (req, res) => {
    if (!req.session || !req.session.user || !req.session.user.id) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const { newPlan } = req.body;
        if (!['free', 'premium', 'ultimate'].includes(newPlan.toLowerCase())) {
            return res.status(400).json({ error: 'Invalid subscription plan' });
        }

        const user = await getFullUserData(req.session.user.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        // Update user's subscription plan
        await db.collection('users').updateOne(
            { _id: new ObjectId(req.session.user.id) },
            { $set: { currentPlan: newPlan.toLowerCase() } }
        );

        res.json({ success: true, plan: newPlan.toLowerCase() });
    } catch (error) {
        console.error('Error changing subscription:', error);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

app.post('/api/subscription/check-order', requireAuth, async (req, res) => {
    const { orderId } = req.body;

    if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
    }

    try {
        // Check if user's plan is already updated
        const user = await db.collection('users').findOne({
            $or: [
                { orderId: orderId },
                { 'subscriptionHistory.orderId': orderId }
            ]
        });

        if (user && user.plan !== 'free') {
            console.log('✅ Subscription status:', {
                email: user.email,
                plan: user.plan
            });
            return res.json({ success: true, plan: user.plan });
        }

        return res.json({ success: false, message: 'Order not processed yet' });
    } catch (error) {
        console.error('❌ Error checking order:', error.message);
        res.status(500).json({ error: 'Failed to check order' });
    }
});

// FastSpring webhook handler
app.post('/webhook/fastspring', express.raw({ type: 'application/json' }), async (req, res) => {
    console.log('\n=== FastSpring Webhook Received ===');
    console.log('Headers:', req.headers);
    console.log('Raw Body:', req.body.toString());

    try {
        const payload = JSON.parse(req.body.toString());
        console.log('Parsed Webhook Payload:', JSON.stringify(payload, null, 2));

        const events = payload.events || [];
        console.log(`Processing ${events.length} events`);

        for (const event of events) {
            console.log('\n--- Processing Event ---');
            console.log('Event Type:', event.type);
            console.log('Event Data:', JSON.stringify(event.data, null, 2));

            try {
                if (event.type === 'order.completed') {
                    const subscriptionData = event.data;
                    const tags = subscriptionData.tags || {};
                    const userId = tags.userId;
                    const email = tags.email;
                    const plan = subscriptionData.product.includes('premium') ? 'premium' : 'ultimate';

                    console.log('Updating subscription for user:', {
                        userId,
                        email,
                        plan,
                        subscriptionId: subscriptionData.id
                    });

                    // Update user's plan
                    const result = await db.collection('users').updateOne(
                        { _id: new ObjectId(userId) },
                        {
                            $set: {
                                plan: plan,
                                currentPlan: plan,
                                subscriptionStatus: 'active',
                                subscriptionId: subscriptionData.id,
                                updatedAt: new Date()
                            }
                        }
                    );

                    console.log('Database update result:', result);

                    // Verify update
                    const updatedUser = await db.collection('users').findOne({ _id: new ObjectId(userId) });
                    console.log('Updated user:', updatedUser);
                }
            } catch (error) {
                console.error(`Error processing event ${event.type}:`, error);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Check order status endpoint
app.post('/api/subscription/check-order', async (req, res) => {
    const { orderId } = req.body;

    if (!orderId) {
        return res.status(400).json({ error: 'Order ID is required' });
    }

    try {
        // Check if user's plan is already updated
        const user = await db.collection('users').findOne({
            $or: [
                { orderId: orderId },
                { 'subscriptionHistory.orderId': orderId }
            ]
        });

        if (user && user.plan !== 'free') {
            console.log('✅ Subscription status:', {
                email: user.email,
                plan: user.plan
            });
            return res.json({ success: true, plan: user.plan });
        }

        return res.json({ success: false, message: 'Order not processed yet' });
    } catch (error) {
        console.error('❌ Error checking order:', error.message);
        res.status(500).json({ error: 'Failed to check order' });
    }
});

// Cancel subscription endpoint
app.post('/api/subscription/cancel', requireAuth, async (req, res) => {
    console.log('\n=== Canceling Subscription ===');
    try {
        const userId = req.session.user.id;
        const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });

        if (!user || !user.subscriptionId) {
            return res.status(400).json({ error: 'No active subscription found' });
        }

        // Update user's subscription status
        await db.collection('users').updateOne(
            { _id: new ObjectId(userId) },
            { $set: { subscriptionStatus: 'cancelled', updatedAt: new Date() } }
        );

        // Send email notification
        if (user.email) {
            await transporter.sendMail({
                from: `"Chatguru" <${process.env.EMAIL_USER}>`,
                to: user.email,
                subject: 'Subscription Cancellation Confirmation - Chatguru',
                html: `
                    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                        <h2>Subscription Cancellation Confirmed</h2>
                        <p>Hello,</p>
                        <p>Your Chatguru subscription has been cancelled but will remain active until the end of your billing period.</p>
                        <p>After that:</p>
                        <ul>
                            <li>Plan changes to free</li>
                            <li>Unlocked characters reset</li>
                            <li>Free tier benefits: 20 messages/day, 20 diamonds</li>
                        </ul>
                        <p>Changed your mind? <a href="${process.env.APP_URL}/subscription.html">Reactivate your subscription</a></p>
                    </div>
                `
            });
            console.log('✅ Cancellation email sent');
        }

        console.log('✅ Subscription cancelled successfully');
        res.json({ success: true });
    } catch (error) {
        console.error('Error canceling subscription:', error);
        res.status(500).json({ error: 'Failed to cancel subscription', details: error.message });
    }
});

// Serve static files
app.use(express.static('public', {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            // Add cache control for HTML files
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Routes
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password, referralCode } = req.body;
        console.log('Signup request with referral code:', referralCode); // Add logging

        // Input validation
        if (!name || !email || !password) {
            return res.status(400).json({ message: 'All fields are required' });
        }

        if (!validateEmail(email)) {
            return res.status(400).json({ message: 'Invalid email format' });
        }

        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long' });
        }

        const lowerEmail = email.toLowerCase();

        // Check if user exists
        const existingUser = await findUserByEmail(lowerEmail);
        if (existingUser) {
            return res.status(400).json({ message: 'Email already registered' });
        }

        // Check for existing verification
        const existingVerification = pendingVerifications.get(lowerEmail);
        if (existingVerification) {
            // Delete any existing verification and proceed with new signup
            pendingVerifications.delete(lowerEmail);
        }

        // Generate verification code
        const verificationCode = generateVerificationCode();
        const hashedPassword = await bcrypt.hash(password, 10);

        // Send verification email first
        await sendVerificationEmail(lowerEmail, verificationCode);

        // Store verification data
        const verificationData = {
            email: lowerEmail,
            name: name.trim(),
            password: hashedPassword,
            verificationCode,
            createdAt: new Date(),
            attempts: 0,
            messagesLeft: 0,  
            diamonds: 0,
            currentPlan: 'free',
            unlockedCharacters: [], 
            referralCode: referralCode 
        };
        console.log('Storing verification data with referral code:', verificationData.referralCode); // Add logging
        pendingVerifications.set(lowerEmail, verificationData);

        res.status(200).json({ message: 'Verification code sent to your email' });

    } catch (error) {
        console.error('Signup error:', error);
        if (error.code === 'EAUTH') {
            res.status(500).json({ message: 'Email service error. Please try again later.' });
        } else {
            res.status(500).json({ message: 'An error occurred during signup. Please try again.' });
        }
    }
});

app.post('/api/auth/resend-verification', async (req, res) => {
    try {
        const { email } = req.body;
        const lowerEmail = email.toLowerCase();

        const verification = pendingVerifications.get(lowerEmail);
        if (!verification) {
            return res.status(400).json({ message: 'No pending verification found. Please sign up again.' });
        }

        // Generate new verification code
        const verificationCode = generateVerificationCode();

        // Send new verification email
        await sendVerificationEmail(lowerEmail, verificationCode);

        // Update verification data
        verification.verificationCode = verificationCode;
        verification.attempts = 0;
        pendingVerifications.set(lowerEmail, verification);

        res.status(200).json({ message: 'New verification code sent' });

    } catch (error) {
        console.error('Resend verification error:', error);
        res.status(500).json({ message: 'Failed to resend verification code. Please try again.' });
    }
});

app.post('/api/auth/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        const lowerEmail = email.toLowerCase();

        const verification = pendingVerifications.get(lowerEmail);
        if (!verification) {
            return res.status(400).json({ message: 'No pending verification found' });
        }

        if (verification.attempts >= 3) {
            pendingVerifications.delete(lowerEmail);
            return res.status(400).json({ message: 'Too many attempts. Please request a new code.' });
        }

        if (code !== verification.verificationCode) {
            verification.attempts++;
            return res.status(400).json({ message: 'Invalid verification code' });
        }

        // Create new user with all fields
        const newUser = {
            email: verification.email,
            name: verification.name,
            password: verification.password,
            verified: true,
            messagesLeft: 0,  
            earnedMessages: 0, // Track earned messages separately
            diamonds: 20,  
            currentPlan: 'free',
            unlockedCharacters: [], 
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const userId = await createUser(newUser);

        // Process referral reward if there was a referral code
        if (verification.referralCode) {
            console.log('Processing referral for code:', verification.referralCode);
            const success = await addReferralReward(verification.referralCode);
            console.log('Referral processing result:', success);
        }

        // Set session with all user data
        req.session.user = {
            id: userId.toString(),
            email: verification.email,
            name: verification.name,
            messagesLeft: newUser.messagesLeft,
            diamonds: newUser.diamonds,
            currentPlan: newUser.currentPlan,
            unlockedCharacters: newUser.unlockedCharacters
        };

        pendingVerifications.delete(lowerEmail);
        res.json({ 
            success: true,
            user: {
                id: userId.toString(),
                email: verification.email,
                name: verification.name,
                messagesLeft: newUser.messagesLeft,
                diamonds: newUser.diamonds,
                currentPlan: newUser.currentPlan,
                unlockedCharacters: newUser.unlockedCharacters
            }
        });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ message: 'An error occurred during verification. Please try again.' });
    }
});

// Start the server
connectDB().then(() => {
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    });
}).catch(console.error);
