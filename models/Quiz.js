import mongoose from 'mongoose';

const questionSchema = new mongoose.Schema({
  id: Number,
  question: String,
  options: [String],
  answer: String
});

const quizSchema = new mongoose.Schema({
  title: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Links to the creator
  questions: [questionSchema],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model('Quiz', quizSchema);