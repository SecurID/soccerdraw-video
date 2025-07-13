# Soccer Tactics Video Annotator

A web application for annotating soccer videos with tactical drawings and exporting them as new video files.

## Features

- Upload and annotate video files with drawings
- Multiple drawing tools: pen, arrow, circle, rectangle
- Custom colors and brush sizes
- Frame-by-frame annotation
- Backend video processing with FFmpeg
- Export annotated videos

## Prerequisites

Before running the application, make sure you have:

1. **Node.js** (version 16 or higher)
2. **FFmpeg** installed on your system

### Installing FFmpeg

#### macOS (using Homebrew):
```bash
brew install ffmpeg
```

#### Ubuntu/Debian:
```bash
sudo apt update
sudo apt install ffmpeg
```

#### Windows:
Download from https://ffmpeg.org/download.html and add to PATH

## Installation

### System Dependencies

Before installing Node.js dependencies, you need to install system packages for the canvas module:

#### macOS:
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

#### Ubuntu/Debian:
```bash
sudo apt update
sudo apt install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
```

### Node.js Dependencies

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

Or for development with auto-restart:
```bash
npm run dev
```

3. Open your browser and navigate to:
```
http://localhost:3000
```

## Usage

1. **Upload Video**: Click the upload area and select your video file
2. **Annotate**: Use the drawing tools to add tactical annotations
   - Select tool (pen, arrow, circle, rectangle)
   - Choose color and brush size
   - Draw on the video frame
3. **Navigate**: Use video controls to move between frames
4. **Export**: Click "Export Annotated Video" to process and download

## API Endpoints

- `POST /api/upload` - Upload video file
- `POST /api/process` - Process video with annotations
- `GET /api/download/:filename` - Download processed video

## Project Structure

```
├── index.html          # Frontend application
├── server.js           # Node.js backend server
├── package.json        # Dependencies and scripts
├── uploads/            # Uploaded video files
├── output/             # Processed video files
├── temp/               # Temporary processing files
└── README.md           # This file
```

## Troubleshooting

### FFmpeg not found
Make sure FFmpeg is installed and available in your system PATH.

### Canvas module compilation issues
If you encounter issues with the canvas module, make sure you have the system dependencies installed first:

**macOS:**
```bash
brew install pkg-config cairo pango libpng jpeg giflib librsvg
npm rebuild canvas
```

**Ubuntu/Debian:**
```bash
sudo apt install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
npm rebuild canvas
```

### Large file uploads
Adjust the file size limits in `server.js` if needed for larger videos.

## Supported Video Formats

- MP4
- MOV
- AVI
- MKV
- WebM

## Technical Details

The application uses:
- **Frontend**: HTML5 Canvas API for drawing
- **Backend**: Node.js with Express
- **Video Processing**: FFmpeg with fluent-ffmpeg
- **Canvas Rendering**: node-canvas for server-side drawing
- **File Upload**: Multer for handling multipart/form-data

The processing workflow:
1. Video uploaded to server
2. Annotations stored as frame-based shape data
3. Server creates PNG overlays for each annotated frame
4. FFmpeg merges overlays with original video
5. Processed video available for download