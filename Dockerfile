# Node base with Debian packages for OCR & PDF rasterization
FROM node:20-bullseye

RUN apt-get update && apt-get install -y \
    poppler-utils \
    tesseract-ocr \
    tesseract-ocr-eng \
    wget \
    libpng-dev libjpeg-dev build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

RUN mkdir -p /usr/src/app/uploads /usr/src/app/public

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
