FROM node:10.15.1-alpine

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

COPY package-lock.json ./
COPY package.json ./

RUN npm install

COPY app.js ./

CMD ["node", "app.js"]
