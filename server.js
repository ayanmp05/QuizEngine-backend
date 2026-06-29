import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse';
import Groq from 'groq-sdk'; 
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

// Initialize Groq Client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Helper function to prevent rate limits
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// PROTECTED ROUTE: Upload PDF and Generate Quiz
app.post('/api/upload', verifyToken, upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    const pdfData = await pdfParse(req.file.buffer);
    let fullText = pdfData.text;

    // --- NEW FIX 1: Cut off the document before the Answer Key begins ---
    // This instantly deletes the "Explanations" at the bottom of the PDF
    fullText = fullText.split(/CORRECT ANSWERS:|Explanations:/i)[0];

    // 1. LOGICAL SPLIT
    const questionMatches = fullText.split(/(?=\n\s*\d+\.\s)/);
    
    // --- NEW FIX 2: Filter out Hindi and Noise ---
    const questions = questionMatches.filter(q => {
      const isLongEnough = q.trim().length > 50;
      // This Regex detects Devanagari (Hindi) characters. If true, we throw the chunk away.
      const hasHindiCharacters = /[\u0900-\u097F]/.test(q); 
      
      return isLongEnough && !hasHindiCharacters;
    });

    // 2. BATCHING: Group into batches of 10 to protect Token Limits
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < questions.length; i += BATCH_SIZE) {
      batches.push(questions.slice(i, i + BATCH_SIZE).join('\n'));
    }

    // 3. PROCESSING FUNCTION (Powered by Groq)
    const processBatch = async (batchText) => {
      const prompt = `
        You are an expert exam processor. Extract multiple-choice questions, options, and correct answers from the following study text.
        
        CRITICAL INSTRUCTIONS:
        1. DYNAMIC LANGUAGE HANDLING: 
           - If the text contains the SAME question translated into multiple languages (e.g., English and Hindi side-by-side), you MUST prioritize and extract ONLY the English version. 
           - If the text is provided entirely in a regional language (e.g., Bengali) without English translations, extract the questions, options, and answers exactly in that native regional language.
        2. CAPTURE DIRECTION BLOCKS: Look for instruction blocks that apply to multiple questions (e.g., "Directions: The questions are based upon..."). You MUST prepend this exact instruction/series string to the front of the "question" field for EVERY single question it applies to.
        3. EXTRACT OPTIONS: Locate and extract the multiple-choice options (which may be labeled A, B, C, D, E OR 1, 2, 3, 4) from the text immediately following the question. The "options" array MUST contain at least 4 strings. NEVER leave the options array empty.
        4. ANSWER EXTRACTION: Extract the correct answer string. Note that the answer may be located at the very end of the document, OR directly underneath the question options (e.g., "Answer: Option 3: 15 km").
        5. IGNORE NOISE: Strictly ignore promotional headers/footers, website URLs ("smartkeeda.com", "testbook.com"), page numbers, phrases like "View this Question Online", "Detailed Solution Below", and detailed step-by-step mathematical explanations.
        6. Output a strict JSON array of objects following this exact schema:

        [
          {
            "id": 1,
            "question": "The combined directions/series text AND the specific question text string",
            "options": [
              "Option 1/A text",
              "Option 2/B text",
              "Option 3/C text",
              "Option 4/D text"
            ],
            "answer": "The exact correct option string matching one of the items in the options array"
          }
        ]

        Unstructured text data:
        ${batchText}
      `;
      
      // Call Groq API with System Prompt configuration to prevent conversational chatter
      const chatCompletion = await groq.chat.completions.create({
        messages: [
          { 
            role: "system", 
            content: "You are a data pipeline. You must output ONLY a valid JSON array. Never include any conversational text, greetings, or explanations before or after the JSON." 
          },
          { 
            role: "user", 
            content: prompt 
          }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1, 
      });
      
      let responseText = chatCompletion.choices[0]?.message?.content || "[]";
      
      // --- REGEX BOUNDARY FILTER ---
      // Captures everything starting from the first '[' to the final ']', isolating the valid JSON array
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        responseText = jsonMatch[0];
      } else {
        responseText = "[]"; 
      }
      
      // Cleanup whitespace, control characters, and backslashes
      responseText = responseText.replace(/```json/gi, '').replace(/```/gi, '').trim();
      responseText = responseText.replace(/\\(?!["\\/bfnrtu])/g, "\\\\");
      responseText = responseText.replace(/[\u0000-\u001F]+/g, "");
      
      return JSON.parse(responseText);
    };

    // 4. EXECUTE BATCHES SEQUENTIALLY
    const finalQuestions = [];
    for (const batch of batches) {
      const batchResult = await processBatch(batch);
      finalQuestions.push(...batchResult);
      // Wait 15 seconds between batches to ensure we stay under the 12,000 TPM limit
      await delay(15000); 
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
    res.status(500).json({ error: error.message || 'Server failed to process document.' });
  }
});

// PROTECTED ROUTES
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