import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import feedbackRoutes from './routes/feedbackRoutes.js';
import authRoutes from './routes/authRoutes.js'; // Import new authentication routes

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Increase the payload limit to allow Base64 image uploads safely
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/', (req, res) => {
  res.json({ message: "ABUAD SRC Portal API is running smoothly!" });
});

// Mount API Routes middleware
app.use('/api/feedback', feedbackRoutes);
app.use('/api/auth', authRoutes); // Mount authentication endpoints

mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Successfully connected to MongoDB.');
    app.listen(PORT, () => {
      console.log(`Server is operating on port: ${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database connection failed:', error.message);
  });