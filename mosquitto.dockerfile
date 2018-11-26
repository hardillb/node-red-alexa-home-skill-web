FROM ubuntu:18.04

LABEL maintainer="Chris Bradford <chrismbradford@gmail.com>"

# Install Dependencies / Required Services
RUN apt-get -y update \
    && apt-get -y upgrade \
    && apt-get install -y \
    pkg-config \
    libssl-dev \
    cmake \
    git \
    mosquitto \
    mosquitto-clients \
    libmosquitto-dev \
    wget

# Compile and Install Mongo-C-Driver
WORKDIR /usr/local/src
RUN wget https://github.com/mongodb/mongo-c-driver/releases/download/1.13.0/mongo-c-driver-1.13.0.tar.gz \
    && tar zxf ./mongo-c-driver-1.13.0.tar.gz \
    && cd /usr/local/src/mongo-c-driver-1.13.0/ \
    && mkdir -p cmake-build \
    && cd /usr/local/src/mongo-c-driver-1.13.0/cmake-build \
    && cmake -DENABLE_AUTOMATIC_INIT_AND_CLEANUP=OFF .. \
    && make \
    && make install \
    && ldconfig \
    && cd /usr/local/src \
    && rm mongo-c-driver-1.13.0.tar.gz \
    && rm -rf mongo-c-driver-1.13.0

# Compile and Install Mosquito-Auth-Plug, spocific commit version
WORKDIR /usr/local/src
RUN wget https://mosquitto.org/files/source/mosquitto-1.4.15.tar.gz \ 
    && tar xvzf ./mosquitto-1.4.15.tar.gz \
    && git clone https://github.com/jpmens/mosquitto-auth-plug.git \
    && cd /usr/local/src/mosquitto-auth-plug \
    && git checkout 4e7fe9aadbdf6bcf9571b38d293bc0c081dd063b \
    && cp config.mk.in config.mk \
    && sed -i "s|BACKEND_MONGO ?= no|BACKEND_MONGO ?= yes|g" config.mk \
    && sed -i "s|BACKEND_MYSQL ?= yes|BACKEND_MYSQL ?= no|g" config.mk \
    && sed -i "s|MOSQUITTO_SRC =|MOSQUITTO_SRC = /usr/local/src/mosquitto-1.4.15|g" config.mk \
    && make \
    && cp auth-plug.so /usr/local/src \
    && cp np /usr/local/bin/ && chmod +x /usr/local/bin/np \
    && rm -rf /usr/local/src/mosquitto-auth-plug

# Download/ set execute on /docker-entrypoint.sh
WORKDIR /
RUN wget -O docker-entrypoint.sh https://gist.githubusercontent.com/coldfire84/6e82c93dde7bbff2172329554af408fe/raw/6584308375d2f62e22b62f7a13a7ead8eb2e6437/docker-entrypoint.sh \
    &&  chmod +x /docker-entrypoint.sh

# Cleanup
RUN apt-get remove -y cmake git wget pkg-config \
    && apt-get autoremove --yes \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/docker-entrypoint.sh"]

# Execute mosquitto 
CMD ["/usr/sbin/mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]