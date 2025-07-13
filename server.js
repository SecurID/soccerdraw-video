const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const { createCanvas } = require('canvas');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('.'));

// Create directories
const uploadsDir = './uploads';
const outputDir = './output';
const tempDir = './temp';

[uploadsDir, outputDir, tempDir].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({ 
    storage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100MB limit
    fileFilter: (req, file, cb) => {
        const allowedTypes = /mp4|mov|avi|mkv|webm/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only video files are allowed'));
        }
    }
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Upload video endpoint
app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoInfo = {
        id: path.parse(req.file.filename).name,
        filename: req.file.filename,
        originalName: req.file.originalname,
        path: req.file.path,
        size: req.file.size
    };

    res.json({ 
        success: true, 
        video: videoInfo,
        message: 'Video uploaded successfully' 
    });
});

// Process video with annotations
app.post('/api/process', async (req, res) => {
    try {
        const { videoId, annotations, videoData, pauseOnAnnotations, pauseDuration } = req.body;
        
        if (!videoId || !annotations) {
            return res.status(400).json({ error: 'Missing required data' });
        }

        const videoPath = path.join(uploadsDir, videoId + path.extname(videoData.originalName || '.mp4'));
        const outputPath = path.join(outputDir, `annotated_${videoId}.mp4`);
        
        // Check if input video exists
        if (!fs.existsSync(videoPath)) {
            return res.status(404).json({ error: 'Video file not found' });
        }

        console.log('Processing video:', videoPath);
        console.log('Annotations:', Object.keys(annotations).length, 'frames');

        // Get video info first
        const videoInfo = await getVideoInfo(videoPath);
        
        // Create annotated video
        if (pauseOnAnnotations) {
            await createPauseResumeVideo(videoPath, outputPath, annotations, videoInfo, pauseDuration || 2);
        } else {
            await createAnnotatedVideo(videoPath, outputPath, annotations, videoInfo);
        }

        res.json({
            success: true,
            downloadUrl: `/api/download/${path.basename(outputPath)}`,
            filename: `annotated_${videoData.originalName || 'video.mp4'}`
        });

    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({ error: 'Video processing failed: ' + error.message });
    }
});

// Download processed video
app.get('/api/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filePath = path.join(outputDir, filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    res.download(filePath, (err) => {
        if (err) {
            console.error('Download error:', err);
            res.status(500).json({ error: 'Download failed' });
        }
    });
});

// Get video information
function getVideoInfo(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }
            
            const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
            resolve({
                duration: metadata.format.duration,
                width: videoStream.width,
                height: videoStream.height,
                fps: eval(videoStream.r_frame_rate) || 30
            });
        });
    });
}

// Create annotated video
async function createAnnotatedVideo(inputPath, outputPath, annotations, videoInfo) {
    return new Promise((resolve, reject) => {
        const tempOverlayDir = path.join(tempDir, uuidv4());
        fs.mkdirSync(tempOverlayDir, { recursive: true });

        try {
            // Create overlay images for each frame with annotations
            const overlayFiles = createOverlayFrames(annotations, videoInfo, tempOverlayDir);
            
            if (overlayFiles.length === 0) {
                // No annotations, just copy the original video
                fs.copyFileSync(inputPath, outputPath);
                resolve();
                return;
            }

            // Use FFmpeg to overlay annotations onto video
            let command = ffmpeg(inputPath);
            
            // Add overlay filter for each annotated frame
            const filterComplex = createFilterComplex(overlayFiles, videoInfo);
            
            if (filterComplex) {
                // Add overlay input files
                overlayFiles.forEach(overlay => {
                    command = command.input(overlay.path);
                });
                
                command = command
                    .complexFilter(filterComplex)
                    .outputOptions(['-map', '[out]'])
                    .videoCodec('libx264')
                    .audioCodec('copy');
            } else {
                // No overlays needed, just copy
                command = command.videoCodec('copy').audioCodec('copy');
            }

            command
                .output(outputPath)
                .on('start', (commandLine) => {
                    console.log('FFmpeg command:', commandLine);
                })
                .on('progress', (progress) => {
                    console.log('Processing: ' + Math.round(progress.percent) + '% done');
                })
                .on('end', () => {
                    console.log('Video processing completed');
                    // Cleanup temp files
                    fs.rmSync(tempOverlayDir, { recursive: true, force: true });
                    resolve();
                })
                .on('error', (err) => {
                    console.error('FFmpeg error:', err);
                    // Cleanup temp files
                    fs.rmSync(tempOverlayDir, { recursive: true, force: true });
                    reject(err);
                })
                .run();

        } catch (error) {
            fs.rmSync(tempOverlayDir, { recursive: true, force: true });
            reject(error);
        }
    });
}

// Create overlay frames for annotations
function createOverlayFrames(annotations, videoInfo, outputDir) {
    const overlayFiles = [];

    Object.keys(annotations).forEach(frameNumber => {
        const shapes = annotations[frameNumber];
        if (shapes.length === 0) return;

        const canvas = createCanvas(videoInfo.width, videoInfo.height);
        const ctx = canvas.getContext('2d');

        // Clear canvas with transparent background
        ctx.clearRect(0, 0, videoInfo.width, videoInfo.height);

        // Draw all shapes for this frame
        shapes.forEach(shape => {
            drawShapeOnCanvas(ctx, shape);
        });

        // Save canvas as PNG
        const filename = `overlay_${frameNumber.toString().padStart(6, '0')}.png`;
        const filepath = path.join(outputDir, filename);
        
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(filepath, buffer);

        overlayFiles.push({
            frame: parseInt(frameNumber),
            path: filepath,
            timestamp: parseInt(frameNumber) / videoInfo.fps
        });
    });

    return overlayFiles.sort((a, b) => a.frame - b.frame);
}

// Draw shape on canvas context
function drawShapeOnCanvas(ctx, shape) {
    ctx.strokeStyle = shape.color;
    ctx.lineWidth = shape.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (shape.tool) {
        case 'pen':
            ctx.beginPath();
            ctx.moveTo(shape.startX, shape.startY);
            ctx.lineTo(shape.endX, shape.endY);
            ctx.stroke();
            break;

        case 'arrow':
            drawArrowOnCanvas(ctx, shape.startX, shape.startY, shape.endX, shape.endY);
            break;

        case 'circle':
            const radius = Math.sqrt(Math.pow(shape.endX - shape.startX, 2) + Math.pow(shape.endY - shape.startY, 2));
            ctx.beginPath();
            ctx.arc(shape.startX, shape.startY, radius, 0, 2 * Math.PI);
            ctx.stroke();
            break;

        case 'rectangle':
            ctx.beginPath();
            ctx.rect(shape.startX, shape.startY, shape.endX - shape.startX, shape.endY - shape.startY);
            ctx.stroke();
            break;
    }
}

// Draw arrow on canvas
function drawArrowOnCanvas(ctx, fromX, fromY, toX, toY) {
    const headlen = 15;
    const angle = Math.atan2(toY - fromY, toX - fromX);

    // Draw line
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Draw arrowhead
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headlen * Math.cos(angle - Math.PI / 6), toY - headlen * Math.sin(angle - Math.PI / 6));
    ctx.moveTo(toX, toY);
    ctx.lineTo(toX - headlen * Math.cos(angle + Math.PI / 6), toY - headlen * Math.sin(angle + Math.PI / 6));
    ctx.stroke();
}

// Create FFmpeg filter complex for overlays
function createFilterComplex(overlayFiles, videoInfo) {
    if (overlayFiles.length === 0) return null;

    const filters = [];
    let currentInput = '[0:v]';

    overlayFiles.forEach((overlay, index) => {
        const outputLabel = index === overlayFiles.length - 1 ? '[out]' : `[tmp${index}]`;
        
        // Add overlay filter with timing - show for 2 seconds
        const startTime = overlay.timestamp;
        const endTime = overlay.timestamp + 2.0; // Show each annotation for 2 seconds
        
        filters.push(`${currentInput}[${index + 1}:v]overlay=enable='between(t,${startTime},${endTime})'${outputLabel}`);
        
        currentInput = `[tmp${index}]`;
    });

    return filters.join(';');
}

// Create pause/resume video with static annotation displays
async function createPauseResumeVideo(inputPath, outputPath, annotations, videoInfo, pauseDuration) {
    return new Promise((resolve, reject) => {
        const tempDir = path.join('./temp', uuidv4());
        fs.mkdirSync(tempDir, { recursive: true });

        try {
            // Get sorted annotation timestamps
            const annotationTimestamps = Object.keys(annotations)
                .filter(frame => annotations[frame].length > 0)
                .map(frame => parseInt(frame) / videoInfo.fps)
                .sort((a, b) => a - b);

            if (annotationTimestamps.length === 0) {
                // No annotations, just copy the original video
                fs.copyFileSync(inputPath, outputPath);
                resolve();
                return;
            }

            console.log('Creating pause/resume video with timestamps:', annotationTimestamps);

            // Create video segments and static clips
            createVideoSegmentsAndStaticClips(inputPath, tempDir, annotations, videoInfo, annotationTimestamps, pauseDuration)
                .then(() => {
                    // Concatenate all segments
                    return concatenateVideoSegments(tempDir, outputPath, annotationTimestamps.length);
                })
                .then(() => {
                    console.log('Video processing completed');
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    resolve();
                })
                .catch(error => {
                    console.error('Processing error:', error);
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    reject(error);
                });

        } catch (error) {
            fs.rmSync(tempDir, { recursive: true, force: true });
            reject(error);
        }
    });
}

// Create video segments and static clips for each annotation
async function createVideoSegmentsAndStaticClips(inputPath, tempDir, annotations, videoInfo, timestamps, pauseDuration) {
    const segmentPromises = [];
    const staticPromises = [];

    // Create segments between annotations
    for (let i = 0; i <= timestamps.length; i++) {
        const startTime = i === 0 ? 0 : timestamps[i - 1];
        const endTime = i === timestamps.length ? videoInfo.duration : timestamps[i];
        
        if (endTime > startTime) {
            const segmentPath = path.join(tempDir, `segment_${i}.mp4`);
            segmentPromises.push(createVideoSegment(inputPath, segmentPath, startTime, endTime));
        }

        // Create static clip for annotation (except for the last iteration)
        if (i < timestamps.length) {
            const frame = Math.floor(timestamps[i] * videoInfo.fps);
            if (annotations[frame] && annotations[frame].length > 0) {
                const staticPath = path.join(tempDir, `static_${i}.mp4`);
                staticPromises.push(createStaticAnnotationClip(inputPath, staticPath, timestamps[i], annotations[frame], videoInfo, pauseDuration));
            }
        }
    }

    await Promise.all([...segmentPromises, ...staticPromises]);
}

// Create a video segment between two timestamps
function createVideoSegment(inputPath, outputPath, startTime, endTime) {
    return new Promise((resolve, reject) => {
        const duration = endTime - startTime;
        console.log(`Creating segment: ${startTime}s to ${endTime}s (duration: ${duration}s)`);
        
        ffmpeg(inputPath)
            .seekInput(startTime)
            .duration(duration)
            .videoCodec('libx264')
            .audioCodec('copy')
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('Segment command:', commandLine);
            })
            .on('end', () => {
                console.log(`Segment created: ${outputPath}`);
                resolve();
            })
            .on('error', reject)
            .run();
    });
}

// Create a static clip showing the video frame with annotation overlay
function createStaticAnnotationClip(inputPath, outputPath, timestamp, shapes, videoInfo, duration) {
    return new Promise((resolve, reject) => {
        const frameImagePath = path.join(path.dirname(outputPath), `frame_${timestamp.toFixed(3)}.png`);
        const overlayImagePath = path.join(path.dirname(outputPath), `overlay_${timestamp.toFixed(3)}.png`);

        // Extract frame at timestamp
        ffmpeg(inputPath)
            .seekInput(timestamp)
            .frames(1)
            .output(frameImagePath)
            .on('end', () => {
                // Create overlay with annotations
                createAnnotationOverlay(overlayImagePath, shapes, videoInfo);
                
                // Create static video from frame + overlay - loop the image for the duration
                ffmpeg()
                    .input(frameImagePath)
                    .inputOptions(['-loop', '1'])
                    .input(overlayImagePath)
                    .inputOptions(['-loop', '1'])
                    .complexFilter('[0:v][1:v]overlay=0:0[out]')
                    .outputOptions(['-map', '[out]'])
                    .outputOptions(['-t', duration.toString()])
                    .outputOptions(['-r', videoInfo.fps.toString()])
                    .outputOptions(['-pix_fmt', 'yuv420p'])
                    .videoCodec('libx264')
                    .output(outputPath)
                    .on('start', (commandLine) => {
                        console.log('Creating static clip:', commandLine);
                    })
                    .on('end', () => {
                        console.log(`Static clip created: ${outputPath} (${duration}s)`);
                        // Cleanup temp images
                        if (fs.existsSync(frameImagePath)) fs.unlinkSync(frameImagePath);
                        if (fs.existsSync(overlayImagePath)) fs.unlinkSync(overlayImagePath);
                        resolve();
                    })
                    .on('error', reject)
                    .run();
            })
            .on('error', reject)
            .run();
    });
}

// Create annotation overlay image
function createAnnotationOverlay(outputPath, shapes, videoInfo) {
    const canvas = createCanvas(videoInfo.width, videoInfo.height);
    const ctx = canvas.getContext('2d');

    // Clear canvas with transparent background
    ctx.clearRect(0, 0, videoInfo.width, videoInfo.height);

    // Draw all shapes
    shapes.forEach(shape => {
        drawShapeOnCanvas(ctx, shape);
    });

    // Save canvas as PNG
    const buffer = canvas.toBuffer('image/png');
    fs.writeFileSync(outputPath, buffer);
}

// Concatenate all video segments and static clips
function concatenateVideoSegments(tempDir, outputPath, annotationCount) {
    return new Promise((resolve, reject) => {
        // Create concat file list
        const concatList = [];
        
        for (let i = 0; i <= annotationCount; i++) {
            const segmentPath = path.join(tempDir, `segment_${i}.mp4`);
            if (fs.existsSync(segmentPath)) {
                concatList.push(`file '${path.relative(tempDir, segmentPath)}'`);
            }
            
            if (i < annotationCount) {
                const staticPath = path.join(tempDir, `static_${i}.mp4`);
                if (fs.existsSync(staticPath)) {
                    concatList.push(`file '${path.relative(tempDir, staticPath)}'`);
                }
            }
        }

        const concatFilePath = path.join(tempDir, 'concat.txt');
        fs.writeFileSync(concatFilePath, concatList.join('\n'));

        console.log('Concat file contents:');
        console.log(concatList.join('\n'));

        // Use FFmpeg concat demuxer
        ffmpeg()
            .input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .videoCodec('libx264')
            .audioCodec('copy')
            .output(outputPath)
            .on('start', (commandLine) => {
                console.log('FFmpeg concat command:', commandLine);
            })
            .on('end', () => {
                console.log('Video concatenation completed');
                resolve();
            })
            .on('error', (error) => {
                console.error('Concatenation error:', error);
                reject(error);
            })
            .run();
    });
}

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Server error:', error);
    res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Make sure FFmpeg is installed on your system');
});