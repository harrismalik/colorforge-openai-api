# ColorForge API

**AI-powered image editing, recoloring, and visualization for your products, designs, and creative projects.**

ColorForge provides a robust suite of API endpoints to integrate advanced image manipulation capabilities directly into your applications. Powered by OpenAI's DALL-E models, this service allows you to generate, edit, and transform images with simple API calls.

This project is a single-file Deno Deploy server, designed for easy setup and use, and includes interactive documentation to get you started quickly.

**Live Demo & Docs:** [Interactive Documentation](https://colorforge-api.deno.dev/docs)

---

## Features

- **Image Generation**: Create new images from a text prompt.
- **Inpainting/Outpainting**: Edit existing images by providing a mask and a prompt.
- **Intelligent Recoloring**: Change the color of objects in an image while preserving textures and lighting.
- **Product Visualization**: Apply color palettes to images to visualize different product variations.
- **Batch Processing**: Queue multiple jobs for asynchronous processing.
- **Simple Setup**: Single-file implementation with no external dependencies beyond Deno.

---

## API Endpoints

All endpoints are prefixed with `/v1`. An `X-OpenAI-Key` header is required for all endpoints that call the OpenAI API.

### Health & Status

#### `GET /v1/ping`

Checks if the server is running.

- **Response:**
  ```json
  {
    "status": "ok",
    "time": "2023-10-27T10:00:00.000Z"
  }
  ```

### Image Generation

#### `POST /v1/generate`

Generates one or more images from a text prompt.

- **Payload:**
  ```json
  {
    "prompt": "A futuristic cityscape at dusk",
    "n": 1,
    "size": "1024x1024"
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "results": [
      {
        "image": "data:image/png;base64,..."
      }
    ]
  }
  ```

### Image Editing

#### `POST /v1/edit`

Edits an image based on a prompt. You can provide either an `imageUrl` or a `imageBase64`. A `maskBase64` can be included for more targeted edits (inpainting).

- **Payload:**
  ```json
  {
    "imageUrl": "https://example.com/your-image.png",
    "prompt": "Add a cat sitting on the sofa",
    "maskBase64": "data:image/png;base64,..."
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "result": {
      "image": "data:image/png;base64,..."
    }
  }
  ```

#### `POST /v1/recolor`

Applies a new color to the primary object in an image. Provide an array of `colors` to generate multiple variations.

- **Payload:**
  ```json
  {
    "imageUrl": "https://example.com/your-product.png",
    "colors": ["#ff0000", "#00ff00", "#0000ff"],
    "preserveTexture": true
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "results": [
      { "color": "#ff0000", "image": "data:image/png;base64,..." },
      { "color": "#00ff00", "image": "data:image/png;base64,..." },
      { "color": "#0000ff", "image": "data:image/png;base64,..." }
    ]
  }
  ```

#### `POST /v1/visualize`

A convenience endpoint to apply a palette of colors to an image, useful for visualizing product mockups.

- **Payload:**
  ```json
  {
    "imageUrl": "https://example.com/house-exterior.png",
    "palettes": ["#d4c5b3", "#a3b8c2", "#f1e4d3"],
    "areas": "walls and trim"
  }
  ```
- **Response:**
  ```json
  {
    "success": true,
    "variations": [
      { "color": "#d4c5b3", "image": "data:image/png;base64,..." },
      { "color": "#a3b8c2", "image": "data:image/png;base64,..." }
    ]
  }
  ```

### Batch & Job Handling

#### `POST /v1/batch`

Submits a batch of jobs for processing. This demo implementation processes them immediately.

- **Payload:**
  ```json
  {
    "jobs": [
      { "endpoint": "/v1/palettes" },
      { "endpoint": "/v1/generate", "payload": { "prompt": "A test image" } }
    ]
  }
  ```
- **Response:**
  ```json
  {
    "jobId": "job_...",
    "status": "queued"
  }
  ```

#### `GET /v1/jobs/:jobId`

Retrieves the status and result of a batch job.

- **Response:**
  ```json
  {
    "jobId": "job_...",
    "status": "completed",
    "result": [...]
  }
  ```

### Demo Endpoints

#### `GET /v1/palettes`

Returns a list of curated color palettes for demonstration purposes.

- **Response:**
  ```json
  {
    "palettes": [
      { "id": "warm-1", "name": "Warm Neutrals", "colors": [...] }
    ]
  }
  ```

---

## Getting Started

### Prerequisites

- [Deno](https://deno.land/) runtime installed.
- An [OpenAI API key](https://platform.openai.com/account/api-keys) with access to the DALL-E models.

### Running Locally

1. **Clone the repository:**
   ```sh
   git clone https://github.com/your-username/colorforge-openai-api.git
   cd colorforge-openai-api
   ```

2. **Run the server:**
   ```sh
   deno run --allow-net --allow-read src/main.ts
   ```
   The server will start on `http://localhost:8000`.

3. **Explore the documentation:**
   Open your browser and navigate to `http://localhost:8000/docs` to use the interactive API documentation.

### Production Notes

This server is built for [Deno Deploy](https://deno.com/deploy), which provides a scalable, serverless environment.

- **Job Persistence**: The default implementation uses an in-memory `Map` to store job statuses. For a production environment, you should replace this with a persistent storage solution like [Deno KV](https://deno.com/kv), Firebase, or any other database.
- **Authentication**: Secure your endpoints with proper authentication mechanisms suitable for your use case. The `X-OpenAI-Key` is passed directly, but for public-facing apps, you should proxy requests through your own backend.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
