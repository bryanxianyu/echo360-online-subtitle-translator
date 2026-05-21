# Privacy Policy

This extension runs on supported Echo360 and Canvas pages to load, translate, and display subtitle tracks.

The use of information received from Chrome extension APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Data Stored Locally

- Extension settings, such as provider, target language, subtitle display preferences, and optional API key.
- A small local subtitle cache so translated subtitles can be reused after a page refresh.

These values are stored in Chrome local storage on the user's device.

## Data Sent to Translation Services

When the user loads translated subtitles, the source subtitle text is sent to the selected translation provider:

- Google Web
- DeepSeek
- OpenAI
- Gemini
- DeepL

API keys are sent only to the provider selected by the user. This project does not operate a remote server for collecting API keys, subtitles, account data, or browsing history.

The Chrome Web Store build does not enable the local backend feature. Development builds may enable a local backend on the user's own machine for testing.

## Permissions

The Chrome Web Store build requests host permissions only for supported Echo360/Canvas pages and configured translation provider endpoints. Development builds may additionally request localhost permissions for local backend testing.

## Contact

For issues, open a GitHub issue in this repository.
