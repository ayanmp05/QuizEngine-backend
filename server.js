import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import { GoogleGenerativeAI } from '@google/generative-ai';
import cors from 'cors';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

// Import Models & Middleware
import Quiz from './models/Quiz.js';
import Attempt from './models/Attempt.js';
import authRoutes from './routes/authRoutes.js';
import verifyToken from './middleware/verifyToken.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB Database'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// HEALTH CHECK ROUTE
app.get('/', (req, res) => {
  res.status(200).send('QuizEngine API is up and running smoothly! 🚀');
});

// Register Auth Routes
app.use('/api/auth', authRoutes);

const upload = multer({ storage: multer.memoryStorage() });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Helper function to throttle requests (12 seconds delay = 5 req/min)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// PROTECTED ROUTE: Upload PDF and Generate Quiz
app.post('/api/upload', verifyToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const pdfData = await pdfParse(req.file.buffer);
    const fullText = pdfData.text;

    // 1. LOGICAL SPLIT
    const questionMatches = fullText.split(/(?=\n\s*\d+\.\s)/);
    const questions = questionMatches.filter(q => q.trim().length > 50);

    // 2. BATCHING: Group into batches of 20
    const BATCH_SIZE = 20;
    const batches = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      batches.push(questions.slice(i, i + BATCH_SIZE).join('\n'));
    }

    // 3. PARALLEL PROCESSING FUNCTION (Renamed internally for clarity)
    const processBatch = async (batchText) => {
      const model = genAI.getGenerativeModel({ 
        model: "gemini-2.5-flash", 
        generationConfig: { responseMimeType: "application/json" }
      });

      const prompt = `
        You are an expert exam processor. Extract structured JSON questions from these text segments.
        Follow these strict rules:
        - Output a valid JSON array of objects.
        - Fields: id, question, options (array of 4 strings), answer.
        - CAPTURE DIRECTION BLOCKS: Look for instruction blocks that apply to multiple questions and prepend them to the question text.
        - IGNORE promotional headers, footers, and answer explanations.
        
        Text Data:
        ${batchText}
      `;
      
      const result = await model.generateContent(prompt);
      let responseText = result.response.text();
      
      responseText = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();
      responseText = responseText.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      responseText = responseText.replace(/[\u0000-\u001F]+/g, "");
      
      return JSON.parse(responseText);
    };

    // 4. SEQUENTIAL PROCESSING (Throttled to avoid 429 Errors)
    const finalQuestions = [];
    for (const batch of batches) {
      try {
        const batchResult = await processBatch(batch);
        finalQuestions.push(...batchResult);
        
        // Wait 12 seconds to ensure we stay under the 5 requests/minute limit
        await delay(12000); 
      } catch (err) {
        console.error("Batch processing failed, skipping this batch:", err);
      }
    }

    // Save the new Quiz to MongoDB
    const newQuiz = new Quiz({
      title: req.file.originalname,
      userId: req.user._id,
      questions: finalQuestions
    });
    await newQuiz.save();

    res.json({ quizId: newQuiz._id, title: newQuiz.title, questions: finalQuestions });

  } catch (error) {
    console.error('Processing Error:', error);
    res.status(500).json({ error: 'Failed to process document. It might be too large or complex.' });
  }
});

// PROTECTED ROUTES (Unchanged)
app.post('/api/attempts', verifyToken, async (req, res) => {
  try {
    const { quizId, score, accuracyPercent, averageTimeSeconds, details } = req.body;
    const newAttempt = new Attempt({ userId: req.user._id, quizId, score, accuracyPercent, averageTimeSeconds, details });
    await newAttempt.save();
    res.status(201).json({ message: 'Result saved successfully!' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to save attempt.' });
  }
});

app.get('/api/quizzes', verifyToken, async (req, res) => {
  try {
    const quizzes = await Quiz.find({ userId: req.user._id }).select('-questions').sort({ createdAt: -1 });
    res.json(quizzes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch quizzes.' });
  }
});

app.get('/api/quizzes/:id', verifyToken, async (req, res) => {
  try {
    const quiz = await Quiz.findOne({ _id: req.params.id, userId: req.user._id });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found.' });
    res.json(quiz);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load quiz.' });
  }
});

app.get('/api/attempts', verifyToken, async (req, res) => {
  try {
    const attempts = await Attempt.find({ userId: req.user._id }).populate('quizId', 'title').sort({ completedAt: -1 });
    res.json(attempts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attempts.' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server executing smoothly on port ${PORT}`));