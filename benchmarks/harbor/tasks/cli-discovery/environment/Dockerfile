FROM ubuntu:24.04

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/SonarSource/sonarqube-cli/master/user-scripts/install.sh | bash \
    && ln -s /root/.local/share/sonarqube-cli/bin/sonar /usr/local/bin/sonar

WORKDIR /app
