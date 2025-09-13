# Wanikani Aural Reviews

A web application that allows you to practice Wanikani reviews using voice input and output. Listen to descriptions of kanji, radicals, and vocabulary, then respond with your voice to complete reviews.

## Features

- 🎧 **Text-to-Speech**: Listen to questions and feedback
- 🎤 **Speech Recognition**: Answer questions using your voice
- 📊 **Progress Tracking**: Visual progress bar and session statistics
- 🔄 **Real-time API Integration**: Submit answers directly to Wanikani
- 📱 **Responsive Design**: Works on desktop and mobile devices
- ♿ **Accessibility**: Screen reader friendly with proper focus management

## Setup

### Prerequisites

- A modern web browser with speech recognition support (Chrome, Edge, Safari)
- A Wanikani account with an API token

### Getting Your Wanikani API Token

1. Go to [Wanikani Settings](https://www.wanikani.com/settings/personal_access_tokens)
2. Click "Generate New Token"
3. Give it a name (e.g., "Aural Reviews App")
4. Copy the generated token

### Installation

1. Clone or download this repository
2. Open `index.html` in your web browser
3. Enter your Wanikani API token when prompted
4. Start reviewing!

## Usage

### Starting a Review Session

1. Enter your API token in the setup screen
2. The app will fetch available reviews from Wanikani
3. Click "Play Question" to hear the question
4. Click "Start Speaking" and say your answer
5. The app will check your answer and provide feedback
6. Click "Next Question" to continue

### Question Types

The app supports two types of questions:
- **Meaning**: "What is the meaning of this kanji/radical/vocabulary?"
- **Reading**: "What is the reading of this kanji/vocabulary?"

### Voice Commands

- Speak clearly and at a normal pace
- The app will automatically stop listening after you finish speaking
- You can also click "Stop Listening" to end the recording early

## Browser Compatibility

### Speech Recognition
- ✅ Chrome/Chromium (recommended)
- ✅ Edge
- ✅ Safari (limited support)
- ❌ Firefox (not supported)

### Text-to-Speech
- ✅ All modern browsers

## API Integration

This app uses the Wanikani API v2 to:
- Fetch available reviews
- Get subject data (kanji, radicals, vocabulary)
- Submit review results
- Track progress

### Rate Limits

The Wanikani API has rate limits. The app is designed to be respectful of these limits by:
- Only fetching data when needed
- Caching results appropriately
- Not making excessive requests

## Troubleshooting

### Speech Recognition Not Working

1. **Check browser support**: Ensure you're using Chrome, Edge, or Safari
2. **Check microphone permissions**: Allow microphone access when prompted
3. **Check internet connection**: Speech recognition requires internet access
4. **Try refreshing**: Sometimes a page refresh helps

### API Token Issues

1. **Invalid token**: Make sure you copied the token correctly
2. **Expired token**: Generate a new token from Wanikani settings
3. **Network issues**: Check your internet connection

### No Reviews Available

- This is normal! Wanikani only provides reviews when they're due
- Check back later or study more to unlock new reviews
- The app will show a message when no reviews are available

## Development

### Project Structure

```
wanikani-aural-reviews/
├── index.html          # Main HTML file
├── styles.css          # CSS styles
├── script.js           # JavaScript application logic
└── README.md           # This file
```

### Key Components

- **WanikaniAuralReviews**: Main application class
- **Speech Recognition**: Web Speech API integration
- **Text-to-Speech**: Web Speech Synthesis API
- **Wanikani API**: REST API integration for reviews

### Adding Features

The app is designed to be extensible. You can add:
- Different question types
- Custom voice commands
- Additional feedback options
- Progress analytics
- Offline support

## Privacy & Security

- API tokens are stored locally in your browser
- No data is sent to external servers except Wanikani
- Speech recognition data is processed by your browser/device
- The app doesn't collect or store personal information

## Contributing

Feel free to submit issues, feature requests, or pull requests to improve the app!

## License

This project is open source. Feel free to use, modify, and distribute as needed.

## Acknowledgments

- [Wanikani](https://www.wanikani.com/) for the amazing Japanese learning platform
- Web Speech API for voice recognition and synthesis
- The open source community for inspiration and tools

