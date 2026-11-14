from getpass import getpass

def login(client):
    username = input("CVAT username: ")
    password = getpass("CVAT password: ")
    client.login((username, password))
    return username