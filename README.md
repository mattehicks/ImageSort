# D20 Image Viewer

A simple, modern image viewer built with Electron for quickly browsing images and organizing them into folders using keyboard shortcuts.

## Features

- **Keyboard Navigation**: Use arrow keys (← →) to browse through images
- **Quick Organization**: Press number keys (1, 2, 3) to move images to configured folders
- **Configurable Folders**: Set up custom destination folders for sorting images
- **Modern UI**: Clean, dark-themed interface optimized for image viewing

## Installation

1. Install Node.js if you haven't already
2. Navigate to the project folder
3. Install dependencies:
   ```bash
   npm install
   ```

## Running the Application

```bash
npm start
```

## Building an Executable

To create a standalone Windows executable:

```bash
npm run build
```

The executable will be created in the `dist` folder.

## Configuration

The app comes with a default configuration that you can modify:

1. Click the **Settings** button in the toolbar
2. Set your source folder (where your images are located)
3. Configure destination folders with keyboard shortcuts:
   - Press a number key (1, 2, 3, etc.) to move the current image to that folder
   - Customize the folder name and path for each shortcut

Default configuration:
- **Source**: `C:\Users\<user>\Documents\Pictures`
- **1**: instagram folder
- **2**: maybe folder
- **3**: discard folder

## Usage

### Viewing Images
- **← (Left Arrow)**: Previous image
- **→ (Right Arrow)**: Next image

### Moving Images
- **1**: Move current image to first configured folder (default: instagram)
- **2**: Move current image to second configured folder (default: maybe)
- **3**: Move current image to third configured folder (default: discard)

### Other Controls
- **⚙ Settings**: Open configuration panel
- **↻ Reload**: Reload images from the source folder

## Supported Image Formats

- JPG/JPEG
- PNG
- GIF
- BMP
- WebP

## Tips

- The app automatically creates destination folders if they don't exist
- Images are moved (not copied) to destination folders
- Use the Reload button if you add new images to the source folder
- Customize keyboard shortcuts in Settings to match your workflow

<img width="1197" height="801" alt="image" src="https://github.com/user-attachments/assets/daa19be3-ed7d-4acb-b732-4b206fa9cb9a" />

