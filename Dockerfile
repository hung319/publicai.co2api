# Sử dụng image Bun chính thức
FROM oven/bun:1.1-alpine

WORKDIR /app

# Copy file nguồn vào container
COPY server.ts .
# Nếu có package.json thì uncomment dòng dưới
# COPY package.json .
# RUN bun install --production

# Expose port
EXPOSE 3000

# Chạy server
CMD ["bun", "run", "server.ts"]
