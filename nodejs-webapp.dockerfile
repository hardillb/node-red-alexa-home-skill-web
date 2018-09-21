FROM node:8
RUN groupadd -r nodejs && useradd -m -r -g -s /bin/bash nodejs nodejs

USER nodejs

WORKDIR /home/nodejs/app

ENV NODE_ENV production
COPY package*.json ./

RUN npm install --only=production
COPY . . 
CMD ["npm start"]

EXPOSE 3000