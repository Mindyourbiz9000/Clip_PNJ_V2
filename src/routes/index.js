const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.render('pages/home', { title: 'Clip PNJ - Home' });
});

router.get('/about', (req, res) => {
  res.render('pages/about', { title: 'Clip PNJ - About' });
});

module.exports = router;
