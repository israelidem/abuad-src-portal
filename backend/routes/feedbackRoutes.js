import express from 'express';
import Feedback from '../models/Feedback.js';

const router = express.Router();

// Helper function to dynamically map ticket status to Tailwind CSS colors
const getStatusStyles = (status) => {
  switch (status) {
    case 'In Progress':
      return 'bg-blue-100 text-blue-800 border border-blue-300';
    case 'Resolved':
      return 'bg-green-100 text-green-800 border border-green-300';
    case 'Pending':
    default:
      return 'bg-yellow-100 text-yellow-800 border border-yellow-300';
  }
};

// @route   POST /api/feedback
// @desc    Submit new student feedback
router.post('/', async (req, res) => {
  try {
    // Generate a unique Ticket ID (e.g., SRC-172938)
    const ticketId = `SRC-${Math.floor(100000 + Math.random() * 900000)}`;

    const newFeedback = new Feedback({
      ...req.body,
      ticketId,
      statusColor: getStatusStyles('Pending') // Initial state styling
    });

    const savedFeedback = await newFeedback.save();
    res.status(201).json(savedFeedback);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// @route   GET /api/feedback
// @desc    Retrieve all submitted feedback tickets
router.get('/', async (req, res) => {
  try {
    const feedbackList = await Feedback.find().sort({ date: -1 });
    res.json(feedbackList);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// @route   PATCH /api/feedback/:id/status
// @desc    Update ticket status and associated layout styles
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body;
  
  try {
    const statusColor = getStatusStyles(status);
    const updatedFeedback = await Feedback.findByIdAndUpdate(
      req.params.id,
      { status, statusColor },
      { new: true, runValidators: true }
    );

    if (!updatedFeedback) {
      return res.status(404).json({ error: 'Feedback ticket not found.' });
    }

    res.json(updatedFeedback);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

export default router;