const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGO_uri;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get('/', (req, res) => {
  res.send('Digital Life Lessons server is running');
});

async function run() {
  try {
    await client.connect();

    const db = client.db('DigitalLifeLessons');
    const lessonCollections = db.collection('lessonCollection');
    const userCollection = db.collection('userCollection');

    //==========================User======================================//

    app.get('/users', async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    // Get user by email
    app.get('/user/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const result = await userCollection.findOne({ email });
        if (!result) {
          return res.status(404).send({ message: 'User not found' });
        }
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Create or update user
    app.post('/user', async (req, res) => {
      try {
        const user = req.body;
        user.createdAt = new Date();
        const email = user.email;

        const userExists = await userCollection.findOne({ email });
        if (userExists) {
          return res.send({ message: 'user exists', user: userExists });
        }

        // Set default values
        user.isPremium = user.isPremium || false;
        user.role = user.role || 'user';

        const result = await userCollection.insertOne(user);
        res.send(result);
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update user profile & sync lessons
    app.put('/user/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const { displayName, photoURL, ...rest } = req.body;

        // Step 1:  Update user
        const userUpdate = await userCollection.updateOne(
          { email },
          {
            $set: {
              displayName,
              photoURL,
              ...rest,
              updatedAt: new Date(),
            },
          }
        );

        // Step 2️: Update all lessons of this user
        await lessonCollections.updateMany(
          { authorEmail: email },
          {
            $set: {
              authorName: displayName,
              authorImage: photoURL,
            },
          }
        );

        if (userUpdate.matchedCount === 0) {
          return res.status(404).send({ message: 'User not found' });
        }

        const updatedUser = await userCollection.findOne({ email });

        res.send({
          message: 'Profile & lessons updated successfully',
          user: updatedUser,
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // Update user premium status
    app.patch('/user/premium/:email', async (req, res) => {
      try {
        const { email } = req.params;
        const { isPremium } = req.body;

        const result = await userCollection.updateOne(
          { email },
          { $set: { isPremium: isPremium, updatedAt: new Date() } }
        );

        if (result.modifiedCount > 0) {
          res.send({ message: 'User premium status updated successfully' });
        } else {
          res.status(404).send({ message: 'User not found' });
        }
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    //==========================Lessons========================================//

    // Get all lessons or filter by author email
    app.get('/lessons', async (req, res) => {
      const query = {};
      const { email } = req.query;

      if (email) {
        query.authorEmail = email;
      }

      const result = await lessonCollections.find().toArray();
      res.send(result);
    });

    // Create lesson
    app.post('/lessons', async (req, res) => {
      const lesson = req.body;
      const result = await lessonCollections.insertOne(lesson);
      res.send(result);
    });

    // Update lesson by ID
    app.put('/lessons/:id', async (req, res) => {
      const { id } = req.params;
      const updateData = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: updateData };

      const result = await lessonCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // Delete lesson by ID
    app.delete('/lessons/:id', async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };

      const result = await lessonCollections.deleteOne(query);
      res.send(result);
    });

    //==========================Payment=============================//

    app.post('/create-checkout-session', async (req, res) => {
      try {
        const paymentInfo = req.body;
        // console.log(paymentInfo)

        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: 'Life Lessons Premium Membership',
                  description: 'Lifetime access to all premium features',
                },
                unit_amount: 1500,
              },
              quantity: 1,
            },
          ],
          customer_email: paymentInfo.authorEmail,
          mode: 'payment',
          success_url: `${process.env.SITE_DOMAIN}/dashboard/payment_success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.SITE_DOMAIN}/payment/payment-cancelled`,
        });

        // console.log(session)

        res.send({ url: session.url });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // payment success
    app.patch('/payment_success', async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        if (!sessionId)
          return res.status(400).send({ error: 'session_id is required' });

        const session = await stripe.checkout.sessions.retrieve(sessionId);
        console.log(session);

        if (session.payment_status === 'paid') {
          const email = session.customer_email;
          if (!email)
            return res
              .status(400)
              .send({ error: 'No customer email found in session' });

          const result = await userCollection.updateOne(
            { email: email },
            { $set: { isPremium: true, updatedAt: new Date() } }
          );

          if (result.modifiedCount > 0) {
            return res.send({
              success: true,
              message: 'User upgraded to premium',
            });
          } else {
            return res
              .status(404)
              .send({ success: false, message: 'User not found' });
          }
        } else {
          return res
            .status(400)
            .send({ success: false, message: 'Payment not completed' });
        }
      } catch (error) {
        console.error(error);
        res.status(500).send({ error: error.message });
      }
    });

    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    );
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Digital Life Lessons is running port: ${port}`);
});
