import express from 'express';
import { Resend } from 'resend';
import dotenv from 'dotenv';
import User from '../models/User.js';

dotenv.config();
const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// ==========================================
// 1. SIGNUP ROUTE (Generates & Sends OTP)
// ==========================================
router.post('/signup', async (req, res) => {
  try {
    const { fullName, username, matricNumber, password, email, role } = req.body;

    if (!username || !password || !email) {
      return res.status(400).json({ error: 'Email, username, and password fields are mandatory.' });
    }

    // Standard structural check
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Please use a valid email address.' });
    }

    const userExists = await User.findOne({ $or: [{ username }, { email }] });
    if (userExists) {
      return res.status(400).json({ error: 'Username or email address is already taken.' });
    }

    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); 

    const newUser = new User({
      fullName,
      username,
      matricNumber,
      password,
      email,
      role: role || 'student',
      isVerified: false,
      otpCode: otp,
      otpExpiresAt: expiresAt
    });

    await newUser.save();

    await resend.emails.send({
      from: 'Portal Verification <onboarding@resend.dev>',
      to: [email],
      subject: 'Verify Your Account',
      html: `
        <div style="font-family: sans-serif; padding: 20px; max-width: 500px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #006633;">Account Verification Code</h2>
          <p>Please enter the following activation sequence code to verify your profile identity:</p>
          <div style="background-color: #f4f4f4; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; color: #006633; border-radius: 4px; margin: 20px 0;">
            ${otp}
          </div>
          <p style="font-size: 12px; color: #666;">This verification sequence expires in 15 minutes.</p>
        </div>
      `
    });

    res.status(201).json({ message: 'Registration successful! Verification OTP sent to your email.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 2. OTP VERIFICATION ROUTE
// ==========================================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and verification OTP are mandatory.' });
    }

    // Defensive fallback: queries by either email address or username strings[cite: 5]
    const user = await User.findOne({ 
      $or: [{ email: email }, { username: email }] 
    });
    
    if (!user) {
      return res.status(404).json({ error: 'Account record context not found.' });
    }

    if (user.isVerified) {
      return res.status(400).json({ error: 'This profile account has already been verified.' });
    }

    if (user.otpCode !== otp || new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: 'Invalid security code configuration or verification window expired.' });
    }

    user.isVerified = true;
    user.otpCode = null;
    user.otpExpiresAt = null;
    await user.save();

    res.status(200).json({ message: 'Account status successfully verified! You can now log in.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 3. LOGIN ROUTE (Enforces Verification Check)
// ==========================================
router.post('/login', async (req, res) => {
  try {
    const { username, password, role } = req.body;

    const user = await User.findOne({ username, role });
    if (!user || user.password !== password) {
      return res.status(401).json({ error: 'Invalid identifier or security password credentials.' });
    }

    // FIX: Send email string along with error configuration so front-end redirects cleanly[cite: 5]
    if (!user.isVerified) {
      return res.status(403).json({ 
        error: 'Account unverified. Please verify your email first.',
        email: user.email 
      });
    }

    res.status(200).json({
      fullName: user.fullName,
      username: user.username,
      role: user.role
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// 4. FORGOT PASSWORD ROUTE
// ==========================================
router.post('/forgot-password', async (req, res) => {
  try {
    const { identifier } = req.body;

    if (!identifier) {
      return res.status(400).json({ error: 'Username or Matric Number is required.' });
    }

    const user = await User.findOne({
      $or: [{ username: identifier }, { matricNumber: identifier }]
    });

    if (!user) {
      return res.status(404).json({ error: 'No account found with that identifier.' });
    }

    const targetEmail = user.email;
    const recoveryToken = user._id;
    const resetLink = `http://localhost:5173/reset-password?token=${recoveryToken}`;

    const { error } = await resend.emails.send({
      from: 'Portal Recovery <onboarding@resend.dev>',
      to: [targetEmail],
      subject: 'Secure Password Recovery System',
      html: `
        <div style="font-family: sans-serif; padding: 20px; max-width: 600px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #006633; margin-bottom: 20px;">Portal Recovery</h2>
          <p>Hello <strong>${user.fullName || user.username}</strong>,</p>
          <p>Password recovery sequence initialized. Click below to reset your credentials:</p>
          <div style="margin: 25px 0;">
            <a href="${resetLink}" style="background-color: #006633; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;">Reset Password</a>
          </div>
        </div>
      `,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json({ message: 'Password recovery sequence initialized. Check your email.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default router;