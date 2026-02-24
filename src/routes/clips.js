const express = require('express');
const router = express.Router();

// GET /clips - List all clips
router.get('/', (req, res) => {
  // TODO: Replace with real data from database
  const clips = [];
  res.render('pages/clips', { title: 'Clip PNJ - Clips', clips });
});

// GET /clips/:id - View a single clip
router.get('/:id', (req, res) => {
  const { id } = req.params;
  // TODO: Fetch clip from database
  res.render('pages/clip-detail', { title: `Clip #${id}`, clip: null, id });
});

module.exports = router;
